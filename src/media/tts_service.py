"""
Edge-TTS service for Azerbaijani speech synthesis and synchronized word-level subtitle generation.
Uses Microsoft Edge-TTS voice 'az-AZ-BabekNeural' at rate '+10%'.
Generates high-quality MP3 audio and synchronized SRT subtitles.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os
import asyncio
import logging
import re
from pathlib import Path
from datetime import timedelta
from typing import Dict, Any, Tuple, Optional, List
import edge_tts

from config.settings import EDGE_TTS_VOICE, EDGE_TTS_RATE, OUTPUT_DIR

logger = logging.getLogger("tts_service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def format_srt_time(td: timedelta) -> str:
    """Formats a timedelta into standard SRT timestamp format: HH:MM:SS,mmm"""
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    milliseconds = int(td.microseconds / 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def azerbaijani_ordinal_suffix(n: int) -> str:
    """Returns correct vowel-harmonized ordinal suffix in Azerbaijani (-ci, -cü, -cı, -cu)."""
    try:
        val = abs(int(n))
    except (ValueError, TypeError):
        return "-ci"
    last_two = val % 100
    last_one = val % 10
    if last_two in (10, 30):
        return "-cu"
    elif last_two in (20, 50, 70, 80):
        return "-ci"
    elif last_two in (40, 60, 90):
        return "-cı"
    elif last_one in (1, 2, 5, 7, 8):
        return "-ci"
    elif last_one in (3, 4):
        return "-cü"
    elif last_one == 6:
        return "-cı"
    elif last_one in (9, 0):
        return "-cu"
    return "-ci"


def verbalize_baku_price(price: Any) -> str:
    """Formats numeric prices into natural spoken Azerbaijani words for clear TTS."""
    if not price:
        return "münasib qiymət"
    try:
        val = float(price)
        if val >= 1_000_000:
            millions = int(val // 1_000_000)
            remainder = int((val % 1_000_000) // 1_000)
            if remainder > 0:
                return f"{millions} milyon {remainder} min manat"
            return f"{millions} milyon manat"
        elif val >= 1_000:
            thousands = int(val // 1_000)
            remainder = int(val % 1_000)
            if remainder > 0:
                return f"{thousands} min {remainder} manat"
            return f"{thousands} min manat"
        else:
            return f"{int(val)} manat"
    except Exception:
        return f"{price} manat"


def canonicalize_location_phrase(location: str) -> str:
    """Cleans location text into natural phrasing, eliminating redundant locatives."""
    if not location:
        return "Bakı şəhərində"
    loc = location.strip()
    loc = re.sub(r'\bm\.(?:\s*yaxınlığında)?', 'metrosu yaxınlığında', loc, flags=re.IGNORECASE)
    loc = re.sub(r'\bq\.(?:\s*ərazisində)?', 'qəsəbəsində', loc, flags=re.IGNORECASE)
    loc = re.sub(r'\bküç\.', 'küçəsində', loc, flags=re.IGNORECASE)
    loc = re.sub(r'\bpr\.', 'prospektində', loc, flags=re.IGNORECASE)
    loc = re.sub(r'\br-nu', 'rayonunda', loc, flags=re.IGNORECASE)
    loc = re.sub(r'\s+', ' ', loc).strip()
    # Remove awkward duplicate suffixes
    loc = re.sub(r'yaxınlığında ərazisində', 'yaxınlığında', loc, flags=re.IGNORECASE)
    loc = re.sub(r'qəsəbəsində ərazisində', 'qəsəbəsində', loc, flags=re.IGNORECASE)
    loc = re.sub(r'rayonunda ərazisində', 'rayonunda', loc, flags=re.IGNORECASE)
    return loc


def format_location_intro(clean_loc: str) -> str:
    """Formats location into natural sentence introductory phrasing."""
    if any(clean_loc.endswith(suffix) for suffix in ["yaxınlığında", "qəsəbəsində", "küçəsində", "prospektində", "rayonunda", "şəhərində"]):
        return clean_loc
    return f"{clean_loc} ərazisində"


def normalize_azerbaijani_phonetics(text: str) -> str:
    """Normalizes abbreviations, numbers, and units for natural speech synthesis."""
    if not text:
        return ""
    replacements = [
        (r'\b(\d+)\s*000\s*AZN\b', r'\1 min manat'),
        (r'\b(\d+)\s*AZN\b', r'\1 manat'),
        (r'\bAZN\b', 'manat'),
        (r'\bkv\.?\s*m\b', 'kvadrat metr'),
        (r'\bm²\b', 'kvadrat metr'),
        (r'\bq\.(?=\s*ərazisində)', 'qəsəbəsi'),
        (r'\bm\.(?=\s*ərazisində)', 'metrosu'),
        (r'\bq\.(?=\s|$|[,\.!])', 'qəsəbəsində'),
        (r'\bm\.(?=\s|$|[,\.!])', 'metrosu yaxınlığında'),
        (r'\bküç\.(?=\s|$|[,\.!])', 'küçəsində'),
        (r'\bpr\.(?=\s|$|[,\.!])', 'prospektində'),
        (r'metrosu yaxınlığında ərazisində', 'metrosu yaxınlığında'),
        (r'qəsəbəsində ərazisində', 'qəsəbəsində'),
        (r'\b(\d+)/(\d+)\b', r'\2 mərtəbəli binanın \1-ci mərtəbəsində'),
    ]
    for pattern, repl in replacements:
        text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
    return text


def detect_listing_archetype(listing: Dict[str, Any]) -> str:
    """Detects real estate archetype: budget, luxury, villa, or commercial."""
    title_desc = (str(listing.get("title", "")) + " " + str(listing.get("description", ""))).lower()
    loc = (str(listing.get("location", "")) + " " + str(listing.get("address", ""))).lower()
    l_type = str(listing.get("type", "")).lower()

    if l_type in ("villa", "bag") or any(w in title_desc for w in ["villa", "bağ evi", "həyət evi", "sot", "hovuzlu"]):
        return "villa"
    if l_type in ("obyekt", "ofis", "torpaq", "kommersiya") or any(w in title_desc for w in ["obyekt", "ofis", "icarə gəliri", "qeyri-yaşayış"]):
        return "commercial"
    
    price = 0.0
    try:
        price = float(listing.get("price") or 0.0)
    except Exception:
        pass

    if price >= 320_000 or any(w in loc for w in ["ağ şəhər", "white city", "port baku", "bayıl", "badamdar"]) or any(w in title_desc for w in ["penthouse", "premium", "rezidens", "lüks", "panoramik dəniz"]):
        return "luxury"

    return "budget"


def generate_azerbaijani_script(listing: Dict[str, Any], archetype: Optional[str] = None) -> str:
    """
    Generates an energetic, high-converting Azerbaijani narration script for a real estate listing.
    Features archetype-specific storytelling, honest objection handling (roof, stone building),
    price clarity, and clear call-to-action without cheap spammy clickbait.
    """
    arch = archetype or detect_listing_archetype(listing)
    parts = []

    raw_loc = listing.get("location") or listing.get("address") or "Bakı"
    loc_clean = canonicalize_location_phrase(raw_loc)
    loc_intro = format_location_intro(loc_clean)

    rooms = listing.get("rooms")
    area = listing.get("area")
    floor = listing.get("floor")
    floors = listing.get("floors")
    price = listing.get("price")
    spoken_price = verbalize_baku_price(price)
    has_kupca = listing.get("has_bill_of_sale", True)

    desc_lower = (str(listing.get("description", "")) + " " + str(listing.get("title", ""))).lower()
    is_stone = any(kw in desc_lower for kw in ["daş", "minsk", "leninqrad", "eksperimental", "xruşşov"])

    if arch == "luxury":
        # Luxury Penthouse / High-End Tower Archetype
        parts.append(f"{loc_intro} premium səviyyəli möhtəşəm mənzil təqdim olunur.")
        if rooms and area:
            parts.append(f"Geniş {rooms} otaqlı, {int(area)} kvadrat metr sahəsi olan bu mənzil xüsusi zövqlə layihələndirilib.")
        elif rooms:
            parts.append(f"Geniş {rooms} otaqlı, panoramik vitraj pəncərəli yüksək səviyyəli mənzil.")
        if floor and floors:
            suffix = azerbaijani_ordinal_suffix(floor)
            parts.append(f"Mənzil müasir elit kompleksin {floor}{suffix} mərtəbəsində yerləşir.")
        parts.append("Yüksək tavanlar, bahalı təmir materialları və 24 saat qorunan həyəti ilə şəxsi statusunuzun ən gözəl təcəssümüdür.")
        if has_kupca:
            parts.append("Mülkiyyət sənədi çıxarışdır, ipotekaya tam yararlıdır.")
        parts.append(f"Təklif olunan qiymət {spoken_price}.")
        parts.append("Eksklüziv baxış və ətraflı məlumat üçün dərhal əlaqə saxlayın!")

    elif arch == "villa":
        # Villa / Country House Archetype
        parts.append(f"{loc_intro} dörd fəsil yaşamaq üçün ideal lüks villa satışa çıxarıldı.")
        if rooms and area:
            parts.append(f"Geniş {rooms} otaqlı, {int(area)} kvadrat metr yaşayış sahəsi və abadlaşdırılmış həyətyanı sahəsi var.")
        parts.append("Təmiz hava, filterli hovuz, söhbətgah və rahat ailə istirahəti üçün hər bir şərait qurulub.")
        if has_kupca:
            parts.append("Həm torpağın, həm tikilinin tam dövlət çıxarışı var.")
        parts.append(f"Qiyməti {spoken_price}.")
        parts.append("Ailənizlə kurort rahatlığı yaşamaq üçün bu gün zəng edin!")

    elif arch == "commercial":
        # Commercial / Investment Archetype
        parts.append(f"{loc_intro} yüksək piyada axınına malik hazır gəlirli obyekt təklif olunur.")
        if area:
            parts.append(f"Ümumi sahəsi {int(area)} kvadrat metr olan bu obyekt stabil icarə potensialına malikdir.")
        parts.append("Geniş vitraj fasad və əlverişli infrastruktur investisiyanın sürətli geri qayıtmasını təmin edir.")
        if has_kupca:
            parts.append("Qeyri-yaşayış sənədi tam qaydasındadır.")
        parts.append(f"İnvestisiya dəyəri {spoken_price}.")
        parts.append("Gəlirli biznes fürsəti üçün dərhal WhatsApp-a yazın!")

    else:
        # Budget / Family Stone Home Archetype
        parts.append(f"{loc_intro} ailəniz üçün çox sərfəli və rahat bir mənzil təklif olunur.")
        if rooms and area:
            parts.append(f"Tam {rooms} otaqlı, {int(area)} kvadrat metr sahəsi olan işıqlı və rahat mənzildir.")
        elif rooms:
            parts.append(f"{rooms} otaqlı, tam təmirli və səliqəli ailə mənzili.")

        # Floor and stone details with roof objection reassurance
        if floor and floors:
            suffix = azerbaijani_ordinal_suffix(floor)
            parts.append(f"Mənzil {floors} mərtəbəli binanın {floor}{suffix} mərtəbəsində yerləşir.")
            if int(floor) == int(floors) and int(floors) <= 5:
                parts.append("Dam örtüyü tamamilə yenilənib, üst mərtəbədə ayaq səsi olmadan sakit ailə həyatı təmin olunur.")

        if is_stone:
            parts.append("Bina tam daşdır — qalın daş divarlar yayda təbii sərinlik, qışda isə ideal istilik saxlayır.")

        if has_kupca:
            parts.append("Ən əsası nədir bilirsiniz? Dövlət çıxarışı, yəni kupçası var! İpotekaya tam hazırdır!")

        parts.append(f"Qiyməti cəmi {spoken_price}!")

        if listing.get("is_owner"):
            parts.append("Birbaşa sahibindən satılır, vasitəçi komissiyası yoxdur.")
        else:
            parts.append("Bu ərazidə bu qiymətə belə ev nadir hallarda satışa çıxır.")

        parts.append("Ətraflı məlumat və baxış üçün dərhal WhatsApp-a yazın və ya zəng edin!")

    return " ".join(parts)


def convert_cues_to_word_level_srt(cues: List[Any], words_per_chunk: int = 3) -> str:
    """
    Converts sentence-level cues into dynamic 2-3 word karaoke chunks
    for modern vertical video subtitle burning.
    Ensures strictly positive duration for all chunks with no zero-duration errors.
    """
    srt_blocks = []
    global_idx = 1

    for cue in cues:
        raw_text = cue.content.strip()
        # Split on regular whitespace, preserving non-breaking spaces within tokens (e.g. price)
        words = raw_text.split(" ")
        words = [w.strip() for w in words if w.strip()]
        if not words:
            continue

        start_time = cue.start
        end_time = cue.end
        total_duration = max(0.2, (end_time - start_time).total_seconds())

        # Chunk words into groups of words_per_chunk
        chunks = []
        for i in range(0, len(words), words_per_chunk):
            chunk_words = words[i:i + words_per_chunk]
            chunks.append(chunk_words)

        if not chunks:
            continue

        total_chars = sum(len(w) for w in words) or 1
        current_start = start_time

        for i, chunk in enumerate(chunks):
            chunk_text = " ".join(chunk).replace("\u00A0", " ")
            if i == len(chunks) - 1:
                current_end = end_time
            else:
                chunk_chars = sum(len(w) for w in chunk)
                chunk_ratio = chunk_chars / total_chars
                current_end = current_start + timedelta(seconds=total_duration * chunk_ratio)

            # Guard: ensure current_end is strictly greater than current_start
            if current_end <= current_start:
                current_end = current_start + timedelta(milliseconds=150)

            srt_blocks.append(
                f"{global_idx}\n"
                f"{format_srt_time(current_start)} --> {format_srt_time(current_end)}\n"
                f"{chunk_text}\n"
            )
            global_idx += 1
            current_start = current_end

    return "\n".join(srt_blocks)


async def synthesize_speech_async(
    text: str,
    output_audio_path: Path,
    output_srt_path: Path,
    voice: str = EDGE_TTS_VOICE,
    rate: str = EDGE_TTS_RATE,
    use_word_level_subtitles: bool = True
) -> float:
    """
    Synthesizes speech asynchronously using Edge-TTS and saves both audio and SRT.
    Returns estimated audio duration in seconds.
    """
    output_audio_path.parent.mkdir(parents=True, exist_ok=True)
    output_srt_path.parent.mkdir(parents=True, exist_ok=True)

    logger.info(f"Synthesizing speech with voice '{voice}' at rate '{rate}'...")
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    submaker = edge_tts.SubMaker()
    audio_data = bytearray()

    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_data.extend(chunk["data"])
        elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
            if submaker.type is None or submaker.type == chunk["type"]:
                submaker.feed(chunk)

    with open(output_audio_path, "wb") as f:
        f.write(audio_data)

    # Format subtitles
    if use_word_level_subtitles and submaker.cues:
        srt_content = convert_cues_to_word_level_srt(submaker.cues, words_per_chunk=3)
    else:
        srt_content = submaker.get_srt()

    with open(output_srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)

    # Calculate duration from SubMaker cues or MP3 size
    duration = 0.0
    if submaker.cues:
        duration = submaker.cues[-1].end.total_seconds()
    if duration <= 0:
        # Fallback estimation: average 16000 bytes/sec for edge-tts 64kbps mp3
        duration = max(3.0, len(audio_data) / 16000.0)

    logger.info(f"Synthesized {len(audio_data)} bytes ({duration:.2f}s audio) -> {output_audio_path}")
    logger.info(f"Generated SRT subtitles -> {output_srt_path}")
    return duration


def generate_tts_for_listing(
    listing: Dict[str, Any],
    output_dir: Optional[Path] = None,
    voice: str = EDGE_TTS_VOICE,
    rate: str = EDGE_TTS_RATE,
    custom_script: Optional[str] = None
) -> Tuple[str, str, str, float]:
    """
    Synchronous wrapper to generate full Azerbaijani narration script,
    Edge-TTS voiceover, and SRT subtitles for a listing.
    Allows passing a custom AI script (e.g. from Google Gemini Pro).
    Returns: (script_text, audio_path, srt_path, duration_seconds)
    """
    target_dir = output_dir or OUTPUT_DIR
    target_dir.mkdir(parents=True, exist_ok=True)

    bina_id = listing.get("bina_id", "sample")
    audio_path = target_dir / f"voice_{bina_id}.mp3"
    srt_path = target_dir / f"subs_{bina_id}.srt"

    raw_script = custom_script or generate_azerbaijani_script(listing)
    script_text = normalize_azerbaijani_phonetics(raw_script)

    # Check for ElevenLabs or OpenAI Studio Voiceover
    eleven_key = os.getenv("ELEVENLABS_API_KEY", "")
    openai_key = os.getenv("OPENAI_API_KEY", "")
    tts_engine = os.getenv("TTS_ENGINE", "elevenlabs" if eleven_key else ("openai" if openai_key else "edge")).lower()

    if tts_engine == "elevenlabs" and eleven_key:
        try:
            from src.media.elevenlabs_tts import synthesize_elevenlabs_speech
            logger.info("Using ElevenLabs Studio TTS for ultra-realistic human voiceover...")
            duration = synthesize_elevenlabs_speech(
                text=script_text,
                output_audio_path=audio_path,
                output_srt_path=srt_path,
                api_key=eleven_key
            )
            return script_text, str(audio_path.resolve()), str(srt_path.resolve()), duration
        except Exception as e:
            logger.warning(f"ElevenLabs TTS failed: {e}. Falling back to secondary engine...")

    if tts_engine in ("elevenlabs", "openai") and openai_key:
        try:
            from src.media.openai_tts import synthesize_openai_speech
            logger.info("Using OpenAI Studio TTS for natural professional voiceover...")
            duration = synthesize_openai_speech(
                text=script_text,
                output_audio_path=audio_path,
                output_srt_path=srt_path,
                api_key=openai_key
            )
            return script_text, str(audio_path.resolve()), str(srt_path.resolve()), duration
        except Exception as e:
            logger.warning(f"OpenAI TTS failed: {e}. Falling back to Edge-TTS Babek.")

    duration = asyncio.run(synthesize_speech_async(
        text=script_text,
        output_audio_path=audio_path,
        output_srt_path=srt_path,
        voice=voice,
        rate=rate
    ))

    return script_text, str(audio_path.resolve()), str(srt_path.resolve()), duration
