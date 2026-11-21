"""
Baku Estate AI - Citadel Autonomous Sales Squad Orchestrator.
Implements the 4 Autonomous Personas:
1. Sentinel: Address leak guard & 50-100 AZN commission margin defender.
2. Scribe: 1-click Azerbaijani Baku-dialect WhatsApp/DM templates & objection battlecards.
3. Strategist: Pre-call blueprint generator & 10:00 AM daily Top 5 Cockpit Card selector.
4. Janitor: E.164 phone normalizer & post-call voice debrief analyzer.
"""

import sys
import os
import re
import json
import logging
from typing import Dict, Any, Optional, List, Tuple, Union
from datetime import datetime, timezone
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

logger = logging.getLogger("squad_orchestrator")


# =============================================================================
# 1. SENTINEL PERSONA
# =============================================================================
class SentinelPersona:
    """
    Sentinel: Address leak guard & 50-100 AZN commission margin defender.
    - Prevents revealing exact building/apartment numbers so buyers cannot bypass the broker.
    - Defends commission margins against buyer/seller shaving or lowball counter-offers.
    """

    ADDRESS_LEAK_PATTERNS = [
        # Explicit building/block/house numbers
        r'\b(?:bina|bina\s*№|bina\s*no|ev)\s*[:#№]?\s*(\d+[a-zа-яA-ZА-Я]?(?:/\d+)?)\b',
        r'\b(?:mənzil|mənz\.|m\.)\s*[:#№]?\s*(\d+)\b',
        r'\b(?:blok|blok\s*№|blok\s*no)\s*[:#№]?\s*(\d+)\b',
        r'\b(?:məhəllə|kvartal)\s*[:#№]?\s*(\d+)\b',
        # Street + number combinations: e.g. "Təbriz küçəsi 45", "Nizami küç. 12/14"
        r'([A-ZƏÖĞIŞÇa-zəöğışç\s]+(?:küçəsi|küç\.|prospekti|pr\.|döngəsi))\s*[:#№]?\s*(\d+[a-zа-я]?(?:/\d+)?)\b'
    ]

    COMMISSION_SHAVING_PATTERNS = [
        r'(\d+)\s*(?:azn|manat)?\s*(?:endirim|çıx|çıxın|düş|aşağı|azalt)',
        r'komissiya\s*(?:vermək\s*istəmirəm|yoxdur|olmasın|verməyəcəm|ödəmirəm)',
        r'faiz\s*(?:yoxdur|düşün|az\s*edin)',
        r'50\s*(?:azn|manat)',
        r'100\s*(?:azn|manat)',
    ]

    def check_address_leak(self, text: str) -> Dict[str, Any]:
        """
        Scans message or draft for sensitive address details that would allow
        a buyer to bypass the agency.
        """
        if not text:
            return {"has_leak": False, "leaked_tokens": [], "warning": None, "sanitized_text": text}

        leaked_tokens: List[str] = []
        for pattern in self.ADDRESS_LEAK_PATTERNS:
            matches = re.finditer(pattern, text, flags=re.IGNORECASE)
            for m in matches:
                leaked_tokens.append(m.group(0).strip())

        has_leak = len(leaked_tokens) > 0
        warning = None
        sanitized = text

        if has_leak:
            warning = (
                f"⚠️ SENTINEL XƏBƏRDARLIĞI: Dəqiq ünvan detalı ({', '.join(leaked_tokens)}) aşkarlandı! "
                "Müştəri vasitəçini kənarda qoyub birbaşa ünvana gedə bilər. "
                "Zəhmət olmasa bina/mənzil nömrəsini gizlədin, yalnız rayon/metro oriyentirini saxlayın."
            )
            # Sanitize exact numbers to safe placeholders
            for tok in leaked_tokens:
                sanitized = sanitized.replace(tok, "[DƏQİQ ÜNVAN GİZLƏDİLDİ - BAXIŞDA VERİLƏCƏK]")

        return {
            "has_leak": has_leak,
            "leaked_tokens": leaked_tokens,
            "warning": warning,
            "sanitized_text": sanitized
        }

    def defend_commission(
        self,
        offered_amount: Optional[float] = None,
        expected_amount: Optional[float] = None,
        deal_type: str = "SALE",
        listing_price: Optional[float] = None
    ) -> Dict[str, Any]:
        """
        Defends the agency's 1-2% or 50-100 AZN commission margin with a high-converting
        Baku-dialect justification emphasizing legal safety, Kupça verification, and notary support.
        """
        margin_delta = 0.0
        if expected_amount and offered_amount is not None:
            margin_delta = max(0.0, float(expected_amount) - float(offered_amount))
        elif offered_amount is not None and offered_amount < 100.0:
            margin_delta = 100.0 - float(offered_amount)

        is_threat = margin_delta >= 50.0 or (offered_amount is not None and offered_amount == 0.0)

        # Standard resolute Baku-dialect defense script
        defense_script = (
            "Hörmətli müştəri, bizim xidmət haqqımız standart qaydada təsdiqlənmiş tarifdir və tam rəsmidir. "
            "Biz sadəcə ev göstərmirik: Daşınmaz Əmlakın Dövlət Reyestrindən (Kupçadan) çıxarışın təmizliyini, "
            "notarial girov və ipoteka məhdudiyyətlərinin olmamasını, qeydiyyatda olan şəxslərin tam yoxlanılmasını təmin edirik. "
            "Bundan əlavə, danışıqlar zamanı qiymətdə sizin xeyrinizə ən azı 2 000 - 5 000 AZN endirim əldə edirik. "
            "Ona görə 50-100 AZN fərq sizin 100% təhlükəsiz və problemsiz ev sahibi olmağınızın dövlət səviyyəsində qarantıdır."
        )

        return {
            "is_margin_threat": is_threat,
            "margin_delta_azn": margin_delta,
            "strategy": "DEFEND_FULL_COMMISSION",
            "defense_script": defense_script,
            "talking_points": [
                "Kupça və Reyestr hüquqi təmizlik zəmanəti",
                "Mülkiyyətçi ilə danışıqda 2000-5000 AZN endirim qazancı",
                "Notariat və bank ipoteka əməliyyatlarının tam müşayiəti",
                "Risksiz və alqı-satqı müqaviləsinin tam təhlükəsizliyi"
            ]
        }


# =============================================================================
# 2. SCRIBE PERSONA
# =============================================================================
class ScribePersona:
    """
    Scribe: 1-click Azerbaijani Baku-dialect WhatsApp/DM templates & objection battlecards.
    """

    def generate_whatsapp_template(
        self,
        template_type: str,
        listing: Dict[str, Any],
        lead: Optional[Dict[str, Any]] = None,
        custom_note: str = ""
    ) -> str:
        """
        Generates natural, courteous Baku-dialect messages for instant 1-tap dispatch.
        """
        lead = lead or {}
        client_name = lead.get("name") or "Hörmətli müştəri"
        bina_id = listing.get("bina_id") or ""
        loc = listing.get("location") or listing.get("address") or "Bakı"
        rooms = listing.get("rooms", "")
        price = listing.get("price", "")
        curr = listing.get("currency", "AZN")

        try:
            num_price = float(price)
            f_price = f"{int(num_price):,}".replace(",", " ")
        except Exception:
            f_price = str(price)

        ttype = template_type.upper().strip()

        if ttype == "OWNER_FIRST_CONTACT":
            return (
                f"Salam, hər vaxtınız xeyir! bina.az-dakı #{bina_id} nömrəli {loc} ərazisindəki "
                f"elanınızla bağlı narahat edirəm. Hazırda agentliyimizdə bu ərazidə nağd büdcəli "
                f"real alıcımız var. Mənzil hələ satışdadırmı və baxış üçün nə vaxt uyğun olar?"
            )

        elif ttype == "BUYER_INQUIRY_REPLY":
            return (
                f"Salam {client_name}! {loc} ərazisindəki {rooms} otaqlı ({f_price} {curr}) "
                f"mənzilimizlə maraqlandığınız üçün təşəkkür edirik. Mənzilin sənədləri tam qaydasındadır "
                f"(Kupçalıdır) və ipotekaya tam yararlıdır. Sizə mənzilin tam video-turunu və "
                f"baxış üçün uyğun saatları təqdim edə bilərik. Bu gün baxmaq istərdiniz?"
            )

        elif ttype == "PRICE_DROP_ALERT":
            old_p = listing.get("old_price") or f_price
            return (
                f"🔥 Şad xəbər, {client_name}! Sizin maraqlandığınız #{bina_id} nömrəli "
                f"({loc}) mənzilin qiymətində mülkiyyətçi təcili endirim etdi! "
                f"Əvvəlki: {old_p} {curr} ➡️ İndiki: {f_price} {curr}. "
                f"Mənzilə tələbat yüksəkdir, dərhal baxış təyin etmək üçün bizə yazın."
            )

        elif ttype == "SHOWING_CONFIRMATION":
            showing_time = custom_note or "18:00"
            return (
                f"Salam {client_name}, təsdiq edirik: {loc} ərazisindəki mənzilə baxışımız "
                f"bu gün saat {showing_time}-a təyin olundu. Ünvana çatanda mənə zəng edin, "
                f"sizi qarşılayıb mənzili ətraflı göstərəcəm."
            )

        else:
            return (
                f"Salam {client_name}! {loc} ərazisindəki {rooms} otaqlı mənzil ({f_price} {curr}) "
                f"haqqında əlavə məlumat almaq və baxış təyin etmək üçün xidmətinizdəyik."
            )

    def get_objection_battlecard(
        self,
        objection_type: str,
        context: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Retrieves objection battlecard with strategic talking points and Baku-dialect rebuttal.
        """
        obj_key = objection_type.upper().strip()
        context = context or {}

        battlecards = {
            "PRICE_TOO_HIGH": {
                "label": "Qiymət çox bahadır",
                "core_argument": "Ərazinin bazar medianı və təmir keyfiyyəti əsaslandırılır.",
                "baku_rebuttal": (
                    "Razıyam, büdcə çox önəmlidir. Amma nəzərə alın ki, bu ərazidə (metroya 5 dəqiqə məsafədə) "
                    "orta m² qiyməti daha yüksəkdir. Üstəlik mənzildə bahalı materiallarla təmir olunub və "
                    "əlavə xərc tələb etmir. Real alıcı olduğunuz təqdirdə, sahibi ilə danışıb sizin üçün "
                    "maksimum münasib qiymət endirimi alacağıq."
                ),
                "closing_question": "Razısınızsa, bir yerdə mənzilə baxaq, yerində qiyməti müzakirə edək?"
            },
            "NO_KUPCHA": {
                "label": "Kupçası yoxdur / Müqavilədir",
                "core_argument": "MTK-nın etibarlılığı və sənədləşmə hüquqi qaydası izah edilir.",
                "baku_rebuttal": (
                    "Bəli, hazırda MTK müqaviləsidir. Bu bina Bakının ən etibarlı tikinti şirkətlərindən birinə "
                    "məxsusdur və yaxın aylarda dövlət qəbulu bitib Kupçalar paylanacaq. Müqavilə birbaşa MTK-nın "
                    "baş ofisində adınıza rəsmiləşdirilir, heç bir hüquqi risk yoxdur. Əgər yalnız Kupçalı axtarırsınızsa, "
                    "eyni rayonda alternativ variantlarımız da var."
                ),
                "closing_question": "Alternativ Kupçalı variantların da siyahısını göndərim?"
            },
            "DIRECT_OWNER_ONLY": {
                "label": "Vasitəçi ilə işləmirəm / Sahibindən axtarıram",
                "core_argument": "Vasitəçinin alıcıya pulsuz hüquqi xidmət və qiymət endirimi qazandırması.",
                "baku_rebuttal": (
                    "Sizi çox yaxşı başa düşürəm, lakin bizimlə işləməyin əsas üstünlüyü odur ki, biz mülkiyyətçi ilə "
                    "peşəkar danışıq aparıb qiyməti fərdi müraciətdən daha çox endiririk. Sənədlərin notarial "
                    "yoxlanışını və təhlükəsizliyini tam təmin edirik. Ən əsası, siz vaxt itirmirsiniz."
                ),
                "closing_question": "Mənzili birgə dəyərləndirmək üçün bu gün saat 17:00 sizə uyğundur?"
            },
            "COMMISSION_REFUSAL": {
                "label": "Komissiya ödəmək istəmirəm",
                "core_argument": "Xidmətin qazandırdığı 5000+ AZN endirim və hüquqi sığorta.",
                "baku_rebuttal": (
                    "Bizim komissiyamız simvolikdir və biz sahibindən sizin üçün aldığımız endirimlə bu məbləğ "
                    "artıqlaması ilə sizə qayıdır. Bütün alqı-satqı prosesi boyunca hüquqşünaslarımız sizin hüquqlarınızı qoruyur."
                ),
                "closing_question": "Gəlin əvvəlcə mənzilə baxaq, bəyənsəniz şərtləri razılaşdırarıq, olar?"
            }
        }

        card = battlecards.get(obj_key, battlecards["PRICE_TOO_HIGH"])
        return {
            "objection_key": obj_key,
            "label": card["label"],
            "core_argument": card["core_argument"],
            "baku_rebuttal": card["baku_rebuttal"],
            "closing_question": card["closing_question"]
        }


# =============================================================================
# 3. STRATEGIST PERSONA
# =============================================================================
class StrategistPersona:
    """
    Strategist: Pre-call blueprint generator & 10:00 AM daily Top 5 Cockpit Card selector.
    """

    def generate_pre_call_blueprint(
        self,
        listing: Dict[str, Any],
        lead: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Generates an actionable pre-call strategy blueprint for the operator.
        """
        lead = lead or {}
        bina_id = listing.get("bina_id", "")
        loc = listing.get("location") or "Bakı"
        price = listing.get("price", 0)
        has_kupca = listing.get("has_bill_of_sale", True)

        try:
            num_price = float(price)
            f_price = f"{int(num_price):,}".replace(",", " ")
        except Exception:
            f_price = str(price)

        hooks = [
            f"Kupça vəziyyəti: {'Dövlət çıxarışı var (İpotekaya yararlı)' if has_kupca else 'MTK müqaviləsi'}",
            f"Qiymət nöqtəsi: {f_price} AZN ({loc})",
            "Mülkiyyətçi təcili satır, real alıcıya endirim müzakirəsinə açıqdır"
        ]

        structure = [
            "1. Giriş (10s): Salamlaşma və elanın aktivliyini təsdiqləmək.",
            "2. Kvalifikasiya (30s): Alıcının büdcəsi, ödəniş forması (nağd / ipoteka) və köçmə müddəti.",
            "3. Dəyər Vurğusu (30s): Kupça, infrastruktur (metro, məktəb) və qiymət üstünlüyü.",
            "4. Qapalı Təklif / CTA (15s): Konkret baxış saatı təklif etmək ('Bu gün 18:00, yoxsa sabah 12:00?')"
        ]

        pitfalls = [
            "Dəqiq mənzil və ya bina nömrəsini zəngdə deməyin (Sentinel xəbərdarlığı).",
            "Komissiya müzakirəsini ilkin mərhələdə açmayın; dəyəri göstərdikdən sonra təsdiqləyin.",
            "Müştərinin büdcəsini dəqiqləşdirmədən qiymət endirimi vəd etməyin."
        ]

        return {
            "objective": f"#{bina_id} nömrəli mənzilə ({loc}) baxış təyin etmək",
            "listing_summary": f"{loc} | {f_price} AZN | {'Kupçalı' if has_kupca else 'Müqaviləli'}",
            "key_hooks": hooks,
            "call_structure": structure,
            "pitfalls_to_avoid": pitfalls
        }

    def select_daily_top_5_cards(
        self,
        cards: List[Dict[str, Any]],
        listings: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """
        Prioritizes candidate cockpit cards into the executive Daily Top 5 for 10:00 AM briefing.
        """
        scored_cards = []
        for card in cards:
            score = 0
            priority = str(card.get("priority", "NORMAL")).upper()
            if priority == "URGENT":
                score += 100
            elif priority == "HIGH":
                score += 75
            elif priority == "NORMAL":
                score += 50
            else:
                score += 25

            # Boost for price drops / high ticket deals
            headline = str(card.get("headline", "")).lower()
            if "endirimi" in headline or "təcili" in headline:
                score += 20
            if "lüks" in headline or "villa" in headline:
                score += 15

            scored_cards.append((score, card))

        scored_cards.sort(key=lambda x: x[0], reverse=True)
        top_5 = [item[1] for item in scored_cards[:5]]

        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "briefing_title": "🌅 10:00 AM Operator Cockpit: Günün Top 5 Əsas Fürsəti",
            "total_candidates": len(cards),
            "top_cards": top_5,
            "executive_summary": (
                f"Bu gün üçün {len(top_5)} kritik kart seçildi. "
                "Təcili qiymət endirimləri və isti müştəri müraciətləri prioritetləşdirilib."
            )
        }


# =============================================================================
# 4. JANITOR PERSONA
# =============================================================================
class JanitorPersona:
    """
    Janitor: E.164 phone normalizer & post-call voice debrief analyzer.
    """

    # Azerbaijani mobile & landline prefixes
    VALID_PREFIXES = {
        "10", "50", "51",  # Azercell
        "55", "99",        # Bakcell
        "70", "77",        # Nar
        "12",              # Baku landline
        "20", "21", "22", "23", "24", "25", "26"  # Regional
    }

    def normalize_phone_e164(self, raw_phone: Optional[str]) -> Optional[str]:
        """
        Cleans and normalizes raw phone strings to standard E.164 format: +994XXXXXXXXX.
        Returns None if invalid.
        """
        if not raw_phone:
            return None

        # Strip everything except digits and leading plus
        s = str(raw_phone).strip()
        digits = re.sub(r'\D', '', s)

        if not digits:
            return None

        # Case 1: Already has 994 country code
        if digits.startswith("994") and len(digits) == 12:
            prefix = digits[3:5]
            if prefix in self.VALID_PREFIXES:
                return f"+{digits}"

        # Case 2: Starts with local 0 (e.g. 0501234567) -> 10 digits
        if digits.startswith("0") and len(digits) == 10:
            prefix = digits[1:3]
            if prefix in self.VALID_PREFIXES:
                return f"+994{digits[1:]}"

        # Case 3: 9 digits without leading 0 or country code (e.g. 501234567)
        if len(digits) == 9:
            prefix = digits[0:2]
            if prefix in self.VALID_PREFIXES:
                return f"+994{digits}"

        # Case 4: 7 digits local Baku landline (e.g. 4001234)
        if len(digits) == 7:
            return f"+99412{digits}"

        return None

    def is_valid_azerbaijani_phone(self, phone: Optional[str]) -> bool:
        """Returns True if the string normalizes to a valid Azerbaijani E.164 number."""
        return self.normalize_phone_e164(phone) is not None

    def analyze_post_call_debrief(
        self,
        transcript_text: str,
        listing: Optional[Dict[str, Any]] = None,
        lead_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Parses post-call debrief audio transcript or notes to extract budget,
        detected objections, sentiment, deal stage, and automatically drafts
        cockpit card and timeline event payloads.
        """
        text = transcript_text or ""
        # Azerbaijani phonetic and diacritic lowercase normalization (resolves Turkish/Azeri dotted 'İ' issue)
        lower = text.replace("İ", "i").replace("I", "ı").lower().replace("i\u0307", "i")

        # 1. Budget extraction
        budget_azn = None
        budget_match = re.search(r'(\d+(?:[\s.,]\d+)?)\s*(?:min|milyon|min\s*azn|min\s*manat|azn|manat)', lower)
        if budget_match:
            try:
                num_part = budget_match.group(1).replace(" ", "").replace(",", ".")
                val = float(num_part)
                if "min" in budget_match.group(0):
                    val *= 1000
                elif "milyon" in budget_match.group(0):
                    val *= 1000000
                budget_azn = val
            except Exception:
                pass

        # 2. Payment mode
        payment_mode = "UNSPECIFIED"
        if any(k in lower for k in ["ipoteka", "kredit", "bank"]):
            payment_mode = "IPOTEKA"
        elif any(k in lower for k in ["nağd", "nagd", "cash", "əldən"]):
            payment_mode = "CASH"

        # 3. Sentiment detection
        sentiment = "NEUTRAL"
        if any(k in lower for k in ["əla", "çox sağ olun", "bəyəndim", "gələcəm", "razıyam", "uyğundur"]):
            sentiment = "POSITIVE"
        elif any(k in lower for k in ["bahadır", "bəyənmədim", "uzaqdır", "imtina", "istəmirəm", "zəng etməyin"]):
            sentiment = "NEGATIVE"
        elif any(k in lower for k in ["fikirləşim", "baxarıq", "dəqiq deyil", "yoldaşımla danışım"]):
            sentiment = "HESITANT"

        # 4. Detected objections
        objections = []
        if any(k in lower for k in ["bahadır", "baha", "endirim", "qiymət"]):
            objections.append("PRICE_TOO_HIGH")
        if any(k in lower for k in ["kupça", "müqavilə", "sənəd"]):
            objections.append("NO_KUPCHA")
        if any(k in lower for k in ["komissiya", "faiz"]):
            objections.append("COMMISSION_REFUSAL")

        # 5. Deal stage determination
        if any(k in lower for k in ["baxış", "görüş", "saat", "gələcəyik", "ünvana"]):
            stage = "SHOWING_SCHEDULED"
        elif any(k in lower for k in ["təklif", "qiymətə verər", "razılaşsaq"]):
            stage = "OFFER_MADE"
        elif sentiment == "NEGATIVE" and "istəmirəm" in lower:
            stage = "DEAL_LOST"
        elif objections:
            stage = "OBJECTION_PENDING"
        else:
            stage = "QUALIFIED"

        # 6. Auto-drafted suggested cockpit card
        bina_id = (listing or {}).get("bina_id") or ""
        loc = (listing or {}).get("location") or "Bakı"

        draft_headline = f"📞 Zəng Sonrası İcra: #{bina_id} ({stage})"
        draft_text = (
            f"Salam, zəngimizə əsasən qeyd etdim. {loc} mənzili üzrə təfərrüatları "
            "və növbəti addımı təsdiqləmək üçün əlaqə saxlayıram."
        )

        suggested_card = {
            "headline": draft_headline,
            "channel": "WHATSAPP",
            "priority": "HIGH" if stage in ("SHOWING_SCHEDULED", "OFFER_MADE") else "NORMAL",
            "draft_text": draft_text,
            "reason": f"Zəng debrief analizi nəticəsi: Mərhələ={stage}, Sentiment={sentiment}",
            "buyer_lead_id": lead_id,
            "listing_id": (listing or {}).get("id"),
            "bina_id": bina_id
        }

        # 7. Timeline payload
        timeline_event = {
            "actor": "AI_JANITOR",
            "event_type": "CALL_LOG",
            "summary": f"Zəng analizi: Mərhələ={stage}, Büdcə={budget_azn or 'Bilinmir'} AZN, Sentiment={sentiment}",
            "lead_id": lead_id,
            "listing_id": (listing or {}).get("id"),
            "metadata": {
                "budget_azn": budget_azn,
                "payment_mode": payment_mode,
                "sentiment": sentiment,
                "detected_objections": objections,
                "deal_stage": stage
            }
        }

        return {
            "budget_azn": budget_azn,
            "payment_mode": payment_mode,
            "sentiment": sentiment,
            "deal_stage": stage,
            "detected_objections": objections,
            "action_items": [
                f"Müştəri ilə {payment_mode} ödəniş şərtlərini təsdiqlə",
                f"Mərhələni '{stage}' olaraq CRM-də yenilə"
            ],
            "suggested_cockpit_card": suggested_card,
            "timeline_event": timeline_event
        }


# =============================================================================
# 5. MASTER SQUAD ORCHESTRATOR
# =============================================================================
class SquadOrchestrator:
    """
    Coordinates the 4 Autonomous Personas (Sentinel, Scribe, Strategist, Janitor)
    for BakuEstate Citadel sales workflows.
    """

    def __init__(self, repo: Optional[Any] = None):
        self.sentinel = SentinelPersona()
        self.scribe = ScribePersona()
        self.strategist = StrategistPersona()
        self.janitor = JanitorPersona()
        self.repo = repo
        logger.info("Initialized BakuEstate Citadel SquadOrchestrator with 4 Personas.")

    def guard_and_format_outreach(
        self,
        template_type: str,
        listing: Dict[str, Any],
        lead: Optional[Dict[str, Any]] = None,
        custom_note: str = ""
    ) -> Dict[str, Any]:
        """
        Scribe drafts template -> Sentinel guards against address leaks -> returns secure message.
        """
        raw_text = self.scribe.generate_whatsapp_template(template_type, listing, lead, custom_note)
        guard_result = self.sentinel.check_address_leak(raw_text)

        return {
            "original_draft": raw_text,
            "sanitized_draft": guard_result["sanitized_text"],
            "has_leak": guard_result["has_leak"],
            "sentinel_warning": guard_result["warning"],
            "leaked_tokens": guard_result["leaked_tokens"]
        }

    def process_call_audio_debrief(
        self,
        transcript_text: str,
        listing: Optional[Dict[str, Any]] = None,
        lead_id: Optional[str] = None,
        auto_queue_card: bool = False
    ) -> Dict[str, Any]:
        """
        Janitor parses audio transcript -> Strategist refines plan -> optionally queues to Cockpit HUD.
        """
        analysis = self.janitor.analyze_post_call_debrief(transcript_text, listing, lead_id)

        queued_card_result = None
        if auto_queue_card and analysis.get("suggested_cockpit_card"):
            from src.cloud.supabase_repo import SupabaseRepo
            repo = self.repo or SupabaseRepo()
            card_args = analysis["suggested_cockpit_card"]
            queued_card_result = repo.queue_cockpit_card(**card_args)

            # Also append timeline
            tl = analysis["timeline_event"]
            repo.append_lead_timeline_event(
                lead_id=tl.get("lead_id"),
                listing_id=tl.get("listing_id"),
                actor=tl.get("actor", "AI_JANITOR"),
                event_type=tl.get("event_type", "CALL_LOG"),
                summary=tl.get("summary", ""),
                metadata=tl.get("metadata")
            )

        return {
            "analysis": analysis,
            "queued_card_result": queued_card_result
        }
