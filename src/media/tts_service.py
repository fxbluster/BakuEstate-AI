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
import threading
from pathlib import Path
from datetime import timedelta
from typing import Dict, Any, Tuple, Optional, List
import edge_tts

from config.settings import (
    EDGE_TTS_VOICE,
    EDGE_TTS_RATE,
    OUTPUT_DIR,
    ELEVENLABS_VOICE_ARIF,
    ELEVENLABS_VOICE_AYAN,
)

ELEVENLABS_VOICE_ARIF_ID = os.getenv("ELEVENLABS_VOICE_ARIF") or ELEVENLABS_VOICE_ARIF or "ZQJv3hwvRAIC7fvWZ1Qr"
ELEVENLABS_VOICE_AYAN_ID = os.getenv("ELEVENLABS_VOICE_AYAN") or ELEVENLABS_VOICE_AYAN or "DZaip8UahF0Qri1FxU8M"

logger = logging.getLogger("tts_service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

ELEVENLABS_CONCURRENCY_SEMAPHORE = threading.BoundedSemaphore(2)


def format_srt_time(td: timedelta) -> str:
    """Formats a timedelta into standard SRT timestamp format: HH:MM:SS,mmm"""
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    milliseconds = int(td.microseconds / 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


AZ_CARDINAL_UNITS: Dict[int, str] = {
    1: "bir", 2: "iki", 3: "üç", 4: "dörd", 5: "beş",
    6: "altı", 7: "yeddi", 8: "səkkiz", 9: "doqquz"
}
AZ_CARDINAL_TENS: Dict[int, str] = {
    10: "on", 20: "iyirmi", 30: "otuz", 40: "qırx", 50: "əlli",
    60: "altmış", 70: "yetmiş", 80: "səksən", 90: "doxsan", 100: "yüz"
}
AZ_ORDINAL_MAP: Dict[int, str] = {
    1: "birinci", 2: "ikinci", 3: "üçüncü", 4: "dördüncü", 5: "beşinci",
    6: "altıncı", 7: "yeddinci", 8: "səkkizinci", 9: "doqquzuncu",
    10: "onuncu", 20: "iyirminci", 30: "otuzuncu", 40: "qırxıncı", 50: "əllinci",
    60: "altmışıncı", 70: "yetmişinci", 80: "səksəninci", 90: "doxsanıncı", 100: "yüzüncü"
}


def number_to_az_cardinal(n: int) -> str:
    """Converts a positive integer into natural spoken Azerbaijani cardinal words."""
    try:
        val = int(n)
    except (ValueError, TypeError):
        return str(n)
    if val <= 0:
        return str(val)
    if val in AZ_CARDINAL_UNITS:
        return AZ_CARDINAL_UNITS[val]
    if val in AZ_CARDINAL_TENS:
        return AZ_CARDINAL_TENS[val]

    parts = []
    if val >= 100:
        h = val // 100
        val %= 100
        parts.append("yüz" if h == 1 else f"{AZ_CARDINAL_UNITS.get(h, str(h))} yüz")
    if val >= 10:
        t = (val // 10) * 10
        val %= 10
        parts.append(AZ_CARDINAL_TENS.get(t, str(t)))
    if val > 0:
        parts.append(AZ_CARDINAL_UNITS.get(val, str(val)))
    return " ".join(parts)


def number_to_az_ordinal(n: int) -> str:
    """Converts a positive integer into natural spoken Azerbaijani ordinal words."""
    try:
        val = int(n)
    except (ValueError, TypeError):
        return str(n)
    if val <= 0:
        return str(val)
    if val in AZ_ORDINAL_MAP:
        return AZ_ORDINAL_MAP[val]

    parts = []
    if val >= 100:
        h = val // 100
        val %= 100
        if val == 0:
            return "yüzüncü" if h == 1 else f"{AZ_CARDINAL_UNITS.get(h, str(h))} yüzüncü"
        parts.append("yüz" if h == 1 else f"{AZ_CARDINAL_UNITS.get(h, str(h))} yüz")
    if val >= 10:
        t = (val // 10) * 10
        rem = val % 10
        if rem == 0:
            parts.append(AZ_ORDINAL_MAP.get(t, str(t)))
            return " ".join(parts)
        parts.append(AZ_CARDINAL_TENS.get(t, str(t)))
        val = rem
    if val > 0:
        parts.append(AZ_ORDINAL_MAP.get(val, str(val)))
    return " ".join(parts)


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
    """
    Normalizes abbreviations, numbers, and units for natural speech synthesis.
    Verbalizes floor fractions into full Azerbaijani words:
    e.g. '4/9' -> 'doqquz mərtəbəli binanın dördüncü mərtəbəsində'.
    """
    if not text:
        return ""

    def _verbalize_fraction(match: re.Match) -> str:
        f_num = int(match.group(1))
        f_den = int(match.group(2))
        total_word = number_to_az_cardinal(f_den)
        floor_word = number_to_az_ordinal(f_num)
        return f"{total_word} mərtəbəli binanın {floor_word} mərtəbəsində"

    # Replace floor fractions into full Azerbaijani phrasing
    text = re.sub(
        r'\b(\d+)\s*/\s*(\d+)(?:\s*(?:-\s*(?:ci|cü|cı|cu))?\s*mərtəbə(?:si|sində)?)?\b',
        _verbalize_fraction,
        text,
        flags=re.IGNORECASE
    )

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
    ]
    for pattern, repl in replacements:
        text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
    return text


def detect_listing_archetype(listing: Dict[str, Any]) -> str:
    """Detects real estate archetype: budget, luxury, villa, or commercial."""
    override = str(listing.get("archetype_override", "")).lower().strip()
    if override in ("budget", "luxury", "villa", "commercial"):
        return override
    title = str(listing.get("title", "")).lower()
    desc = str(listing.get("description", "")).lower()
    title_desc = f"{title} {desc}"
    loc = (str(listing.get("location", "")) + " " + str(listing.get("address", ""))).lower()
    l_type = str(listing.get("type", "")).lower()
    is_apartment_title = "mənzil" in title or "menzil" in title

    if l_type in ("villa", "bag") or any(w in title for w in ["villa", "bağ evi", "həyət evi", "sot"]) or (not is_apartment_title and any(w in title_desc for w in ["villa", "bağ evi", "həyət evi", "sot", "hovuzlu"])):
        return "villa"
    if l_type in ("obyekt", "ofis", "torpaq", "kommersiya") or any(w in title for w in ["obyekt", "ofis", "qeyri-yaşayış", "kommersiya"]) or (not is_apartment_title and any(w in title_desc for w in ["obyekt", "ofis", "icarə gəliri", "qeyri-yaşayış"])):
        return "commercial"
    
    price = 0.0
    try:
        price = float(listing.get("price") or 0.0)
    except Exception:
        pass

    if price >= 320_000 or any(w in loc for w in ["ağ şəhər", "white city", "port baku", "bayıl", "badamdar"]) or any(w in title_desc for w in ["penthouse", "premium", "rezidens", "lüks", "panoramik dəniz"]):
        return "luxury"

    return "budget"


SCRIPT_ANGLE_ARCHETYPE_MAP = {
    "family": "budget",
    "budget": "budget",
    "investor": "commercial",
    "commercial": "commercial",
    "luxury": "luxury",
    "villa": "villa",
}


def build_price_drop_opening(price_drop_info: Optional[Dict[str, Any]]) -> str:
    """Formats a crisp Azerbaijani 'Qiymət Endi!' opening hook for Rejim 3 price-drop renders."""
    if not price_drop_info:
        return ""
    if isinstance(price_drop_info, str):
        return price_drop_info.strip()

    old_p = price_drop_info.get("old_price_azn") or price_drop_info.get("old_price")
    new_p = price_drop_info.get("new_price_azn") or price_drop_info.get("new_price")
    drop_pct = price_drop_info.get("drop_pct") or price_drop_info.get("price_drop_pct")

    if old_p and new_p:
        old_spoken = verbalize_baku_price(old_p)
        new_spoken = verbalize_baku_price(new_p)
        if drop_pct:
            try:
                pct_val = abs(float(drop_pct))
                return (
                    f"Diqqət, qiymət endi! Qiymət {pct_val:.0f} faiz düşərək "
                    f"{old_spoken} əvəzinə indi {new_spoken} oldu!"
                )
            except Exception:
                pass
        return f"Diqqət, qiymət endi! {old_spoken} əvəzinə indi {new_spoken}!"

    return "Diqqət, qiymət endi! İndi çox daha sərfəli fürsətlə təqdim olunur!"


def _extract_visual_profile_data(visual_profile: Optional[Any]) -> Optional[Dict[str, Any]]:
    """Extracts dictionary representation of PropertyVisualProfile if non-fallback."""
    if not visual_profile:
        return None
    if isinstance(visual_profile, dict):
        if visual_profile.get("is_fallback"):
            return None
        return visual_profile
    if hasattr(visual_profile, "is_fallback"):
        if getattr(visual_profile, "is_fallback"):
            return None
        if hasattr(visual_profile, "to_dict"):
            return visual_profile.to_dict()
        return {
            "renovation_quality": getattr(visual_profile, "renovation_quality", "standard"),
            "floor_and_ceiling": getattr(visual_profile, "floor_and_ceiling", ""),
            "kitchen_appliances": getattr(visual_profile, "kitchen_appliances", ""),
            "view_and_lighting": getattr(visual_profile, "view_and_lighting", ""),
            "hook_sentence_az": getattr(visual_profile, "hook_sentence_az", ""),
            "standout_features": getattr(visual_profile, "standout_features", []),
            "is_fallback": False,
        }
    return None


def generate_azerbaijani_script(
    listing: Dict[str, Any],
    archetype: Optional[str] = None,
    script_angle: Optional[str] = None,
    price_drop_info: Optional[Dict[str, Any]] = None,
    visual_profile: Optional[Any] = None,
) -> str:
    """
    Generates an energetic, high-converting Azerbaijani narration script for a real estate listing.
    Features archetype-specific storytelling, explicit script_angle overrides, optional
    Rejim 3 'Qiymət Endi!' opening hook, verified architectural visual highlights from GPT-4o Vision,
    honest objection handling (roof, stone building), price clarity, and clear call-to-action.
    """
    normalized_angle = str(script_angle or "").strip().lower()
    angle_arch = SCRIPT_ANGLE_ARCHETYPE_MAP.get(normalized_angle)
    arch = archetype or angle_arch or detect_listing_archetype(listing)
    parts = []

    vp_data = _extract_visual_profile_data(visual_profile or listing.get("visual_profile"))

    price_drop_hook = build_price_drop_opening(price_drop_info)
    if price_drop_hook:
        parts.append(price_drop_hook)
    elif normalized_angle == "urgent" or listing.get("is_urgent"):
        parts.append("Təcili satış fürsəti! Bazar dəyərindən aşağı qiymətlə əla təklif!")
    elif vp_data and vp_data.get("hook_sentence_az"):
        hook_txt = (vp_data.get("hook_sentence_az") or "").strip()
        if hook_txt:
            parts.append(hook_txt if hook_txt.endswith((".", "!")) else f"{hook_txt}!")

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

    # Build verified architectural visual highlights in natural Baku conversational dialect
    visual_elements: List[str] = []
    if vp_data:
        hook_txt = (vp_data.get("hook_sentence_az") or "").strip()
        if hook_txt and not any(hook_txt in p for p in parts):
            visual_elements.append(hook_txt if hook_txt.endswith((".", "!")) else f"{hook_txt}!")

        vl = (vp_data.get("view_and_lighting") or "").strip()
        if vl:
            visual_elements.append(f"Baxın, {vl.rstrip('.')} ilə otaqlar gün boyu işıqlı və fərəhdir.")

        fc = (vp_data.get("floor_and_ceiling") or "").strip()
        if fc:
            visual_elements.append(f"Təmirində keyfiyyətli materiallardan istifadə olunub: {fc.rstrip('.')}.")

        ka = (vp_data.get("kitchen_appliances") or "").strip()
        if ka:
            visual_elements.append(f"Mətbəx tam təchiz edilib: {ka.rstrip('.')}.")

        standouts = vp_data.get("standout_features") or []
        if isinstance(standouts, list) and standouts:
            clean_feats = [str(f).strip() for f in standouts if str(f).strip()]
            if clean_feats:
                feats_str = ", ".join(clean_feats[:3])
                visual_elements.append(f"Həmçinin burada {feats_str} kimi rahatlıqlar düşünülüb.")

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
        parts.extend(visual_elements)
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
        parts.extend(visual_elements)
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
        parts.extend(visual_elements)
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

        parts.extend(visual_elements)

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


def _resolve_tts_routing(
    tts_engine: Optional[str],
    voice_id: Optional[str],
    default_edge_voice: str,
) -> Tuple[str, Optional[str], Optional[str], str]:
    """
    Resolves (engine, eleven_voice_id, openai_voice, edge_voice) cleanly without
    mutating global os.environ. Supports friendly aliases like 'eleven_male', 'eleven_female', 'nova', 'ayan', 'arif'.
    """
    eleven_key = os.getenv("ELEVENLABS_API_KEY", "")
    openai_key = os.getenv("OPENAI_API_KEY", "")

    raw_engine = (tts_engine or "").strip().lower()
    eleven_voice_id: Optional[str] = None
    openai_voice: Optional[str] = None
    edge_voice: str = default_edge_voice

    # Normalize friendly voice aliases
    normalized_voice_id = voice_id
    if voice_id and str(voice_id).strip():
        raw_vid = str(voice_id).strip().lower()
        if raw_vid in ("eleven_female", "ayan", "banu", "female"):
            normalized_voice_id = ELEVENLABS_VOICE_AYAN_ID
        elif raw_vid in ("eleven_male", "arif", "male"):
            normalized_voice_id = ELEVENLABS_VOICE_ARIF_ID

    if raw_engine in ("eleven_male", "arif", "male"):
        engine = "elevenlabs"
        eleven_voice_id = normalized_voice_id or ELEVENLABS_VOICE_ARIF_ID
    elif raw_engine in ("eleven_female", "ayan", "female", "banu"):
        engine = "elevenlabs"
        eleven_voice_id = normalized_voice_id or ELEVENLABS_VOICE_AYAN_ID
    elif raw_engine == "nova":
        engine = "openai"
        openai_voice = normalized_voice_id or "nova"
    elif raw_engine in ("elevenlabs", "openai", "edge"):
        engine = raw_engine
        if engine == "elevenlabs":
            eleven_voice_id = normalized_voice_id
        elif engine == "openai":
            openai_voice = normalized_voice_id
        elif engine == "edge" and normalized_voice_id:
            edge_voice = normalized_voice_id
    else:
        engine = os.getenv(
            "TTS_ENGINE",
            "elevenlabs" if eleven_key else ("openai" if openai_key else "edge"),
        ).strip().lower()
        if engine == "elevenlabs":
            eleven_voice_id = normalized_voice_id
        elif engine == "openai":
            openai_voice = normalized_voice_id
        elif engine == "edge" and normalized_voice_id:
            edge_voice = normalized_voice_id

    return engine, eleven_voice_id, openai_voice, edge_voice


def generate_tts_for_listing(
    listing: Dict[str, Any],
    output_dir: Optional[Path] = None,
    voice: str = EDGE_TTS_VOICE,
    rate: str = EDGE_TTS_RATE,
    custom_script: Optional[str] = None,
    tts_engine: Optional[str] = None,
    voice_id: Optional[str] = None,
    script_angle: Optional[str] = None,
    version_num: Optional[int] = None,
    price_drop_info: Optional[Dict[str, Any]] = None,
    model_id: Optional[str] = None,
    voice_speed: Optional[float] = None,
    visual_profile: Optional[Any] = None,
) -> Tuple[str, str, str, float, str, bool]:
    """
    Synchronous wrapper to generate full Azerbaijani narration script,
    voiceover (ElevenLabs / OpenAI / Edge-TTS), and synchronized SRT subtitles.

    - Accepts explicit tts_engine, voice_id, script_angle, version_num, price_drop_info, voice_speed
      without ever mutating global os.environ.
    - Writes versioned files (`voice_{bina_id}_v{n}.mp3`, `subs_{bina_id}_v{n}.srt`) when
      `version_num` is provided, and preserves legacy filenames (`voice_{bina_id}.mp3`,
      `subs_{bina_id}.srt`) when `version_num` is None.

    Returns 6-tuple: (script_text, audio_path, srt_path, duration, engine_used, fallback_triggered)
    """
    target_dir = Path(output_dir) if output_dir else OUTPUT_DIR
    target_dir.mkdir(parents=True, exist_ok=True)

    bina_id = listing.get("bina_id", "sample")
    if version_num is not None:
        ver = max(1, int(version_num))
        audio_path = target_dir / f"voice_{bina_id}_v{ver}.mp3"
        srt_path = target_dir / f"subs_{bina_id}_v{ver}.srt"
    else:
        audio_path = target_dir / f"voice_{bina_id}.mp3"
        srt_path = target_dir / f"subs_{bina_id}.srt"

    if custom_script:
        raw_script = custom_script
        if price_drop_info and "qiymət endi" not in raw_script.lower():
            hook = build_price_drop_opening(price_drop_info)
            if hook:
                raw_script = f"{hook} {raw_script}"
    else:
        raw_script = generate_azerbaijani_script(
            listing,
            script_angle=script_angle,
            price_drop_info=price_drop_info,
            visual_profile=visual_profile,
        )
    script_text = normalize_azerbaijani_phonetics(raw_script)

    eleven_key = os.getenv("ELEVENLABS_API_KEY", "")
    openai_key = os.getenv("OPENAI_API_KEY", "")
    selected_engine, eleven_voice_id, openai_voice, edge_voice = _resolve_tts_routing(
        tts_engine=tts_engine,
        voice_id=voice_id,
        default_edge_voice=voice,
    )

    fallback_triggered = False

    if selected_engine == "elevenlabs":
        if eleven_key:
            try:
                from src.media.elevenlabs_tts import synthesize_elevenlabs_speech, ElevenLabsSynthesisError
                logger.info("Using ElevenLabs Studio TTS for ultra-realistic human voiceover...")
                with ELEVENLABS_CONCURRENCY_SEMAPHORE:
                    duration = synthesize_elevenlabs_speech(
                        text=script_text,
                        output_audio_path=audio_path,
                        output_srt_path=srt_path,
                        api_key=eleven_key,
                        voice_id=eleven_voice_id,
                        model_id=model_id,
                        speed=voice_speed,
                    )
                return (
                    script_text,
                    str(audio_path.resolve()),
                    str(srt_path.resolve()),
                    duration,
                    "elevenlabs",
                    False,
                )
            except Exception as e:
                logger.warning(
                    f"ElevenLabs TTS failed ({type(e).__name__}: {e}). Falling back to secondary engine..."
                )
                fallback_triggered = True
        else:
            logger.warning(
                "ElevenLabs requested but ELEVENLABS_API_KEY is unset. Falling back to secondary engine..."
            )
            fallback_triggered = True

    if selected_engine == "openai" and openai_key:
        try:
            from src.media.openai_tts import synthesize_openai_speech
            logger.info("Using OpenAI Studio TTS for natural professional voiceover...")
            duration = synthesize_openai_speech(
                text=script_text,
                output_audio_path=audio_path,
                output_srt_path=srt_path,
                api_key=openai_key,
                voice=openai_voice,
                model=model_id,
            )
            return (
                script_text,
                str(audio_path.resolve()),
                str(srt_path.resolve()),
                duration,
                "openai",
                False,
            )
        except Exception as e:
            logger.warning(f"OpenAI TTS failed: {e}. Falling back to Edge-TTS.")
            fallback_triggered = True

    # Edge-TTS synthesis (primary or fallback)
    if fallback_triggered:
        if voice_speed is not None and abs(voice_speed - 1.0) > 1e-4:
            pct = int(round((voice_speed - 1.0) * 100))
            effective_rate = f"+{pct}%" if pct >= 0 else f"{pct}%"
        else:
            effective_rate = EDGE_TTS_RATE or "+10%"

        target_voice_str = str(eleven_voice_id or voice_id or "").strip().lower()
        if target_voice_str in (
            "dzaip8uahf0qri1fxu8m",
            "ayan",
            "banu",
            "female",
            "eleven_female",
        ):
            effective_voice = "az-AZ-BanuNeural"
        elif target_voice_str in (
            "zqjv3hwvraic7fvwz1qr",
            "arif",
            "male",
            "eleven_male",
        ):
            effective_voice = "az-AZ-BabekNeural"
        else:
            effective_voice = edge_voice or EDGE_TTS_VOICE or "az-AZ-BabekNeural"
    else:
        if voice_speed is not None and abs(voice_speed - 1.0) > 1e-4:
            pct = int(round((voice_speed - 1.0) * 100))
            effective_rate = f"+{pct}%" if pct >= 0 else f"{pct}%"
        else:
            effective_rate = rate or EDGE_TTS_RATE or "+10%"
        effective_voice = edge_voice or EDGE_TTS_VOICE or "az-AZ-BabekNeural"

    duration = asyncio.run(synthesize_speech_async(
        text=script_text,
        output_audio_path=audio_path,
        output_srt_path=srt_path,
        voice=effective_voice,
        rate=effective_rate,
    ))

    return (
        script_text,
        str(audio_path.resolve()),
        str(srt_path.resolve()),
        duration,
        "edge_fallback" if fallback_triggered else "edge",
        fallback_triggered,
    )
