import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  INSTAGRAM_REEL_REGEX,
  TIKTOK_VIDEO_REGEX,
  formatSocialCommentLeadAlert,
  formatCockpitCardTelegram,
  type SocialCommentLeadAlertPayload,
  type CockpitCardTelegramPayload,
} from "./index.ts";

Deno.test("Regex: Instagram Reel URL validation", () => {
  const validUrls = [
    "https://instagram.com/reel/C8xYz123456",
    "https://www.instagram.com/reel/C8xYz123456/",
    "http://instagram.com/reel/C8xYz_abc-123?utm_source=ig_web_copy_link",
    "https://www.instagram.com/reel/DA12345_xyz/?igsh=MWx123==",
  ];

  for (const url of validUrls) {
    assertEquals(INSTAGRAM_REEL_REGEX.test(url), true, `Should match valid IG Reel: ${url}`);
  }

  const invalidUrls = [
    "https://instagram.com/p/C8xYz123456", // Post, not reel
    "https://instagram.com/stories/user/12345",
    "https://youtube.com/shorts/12345",
    "https://evil.com/fake/instagram.com/reel/123",
    "not_a_url",
  ];

  for (const url of invalidUrls) {
    assertEquals(INSTAGRAM_REEL_REGEX.test(url), false, `Should NOT match: ${url}`);
  }
});

Deno.test("Regex: TikTok Video URL validation", () => {
  const validUrls = [
    "https://tiktok.com/@user/video/73918237192837128",
    "https://www.tiktok.com/@baku.emlak_official/video/1234567890123456789",
    "http://tiktok.com/@agent-007.baku/video/9876543210123456789?is_from_webapp=1",
    "https://www.tiktok.com/@user/video/73918237192837128/",
  ];

  for (const url of validUrls) {
    assertEquals(TIKTOK_VIDEO_REGEX.test(url), true, `Should match valid TikTok: ${url}`);
  }

  const invalidUrls = [
    "https://tiktok.com/@user",
    "https://tiktok.com/video/12345",
    "https://youtube.com/shorts/12345",
    "https://evil.com/fake/tiktok.com/@user/video/123",
  ];

  for (const url of invalidUrls) {
    assertEquals(TIKTOK_VIDEO_REGEX.test(url), false, `Should NOT match: ${url}`);
  }
});

Deno.test("Social Comment Lead Alert: formatting and DM link generation", () => {
  const payload: SocialCommentLeadAlertPayload = {
    bina_id: "5616503",
    location: "Nərimanov m.",
    price: 250000,
    currency: "AZN",
    author_handle: "@rashad_baku",
    comment_text: "Qiyməti nə qədərdir? İpotekaya yararlıdır?",
    suggested_reply: "Salam! Bəli, bu mənzil kupçalıdır və ipotekaya tam yararlıdır.",
  };

  const formatted = formatSocialCommentLeadAlert(payload);

  // Assert Header
  assertMatch(formatted.text, /🎯 <b>Yeni Sosial Şəbəkə Müştəri Sorğusu!<\/b>/);

  // Assert Body elements
  assertMatch(formatted.text, /🏠 <b>Elan:<\/b> #5616503/);
  assertMatch(formatted.text, /📍 <b>Ünvan:<\/b> Nərimanov m\./);
  assertMatch(formatted.text, /💰 <b>Qiymət:<\/b> 250 000 AZN/);
  assertMatch(formatted.text, /👤 <b>Müştəri:<\/b> @rashad_baku/);
  assertMatch(formatted.text, /💬 <b>Şərh:<\/b> "<i>Qiyməti nə qədərdir\? İpotekaya yararlıdır\?<\/i>"/);
  assertMatch(formatted.text, /💡 <b>Təklif olunan cavab:<\/b>/);
  assertMatch(formatted.text, /Salam! Bəli, bu mənzil kupçalıdır/);

  // Assert Keyboard & DM link (strips @ from handle)
  assertEquals(formatted.reply_markup.inline_keyboard.length, 1);
  const button = formatted.reply_markup.inline_keyboard[0][0];
  assertEquals(button.text, "📱 Instagram DM-də Cavab Ver");
  assertEquals(button.url, "https://ig.me/m/rashad_baku");
});

Deno.test("Social Comment Lead Alert: cleans un-prefixed handles", () => {
  const payload: SocialCommentLeadAlertPayload = {
    bina_id: "998877",
    author_handle: "aydan.mammadova",
    comment_text: "Hardadır bu ev?",
  };

  const formatted = formatSocialCommentLeadAlert(payload);
  const button = formatted.reply_markup.inline_keyboard[0][0];
  assertEquals(button.url, "https://ig.me/m/aydan.mammadova");
  assertMatch(formatted.text, /👤 <b>Müştəri:<\/b> @aydan\.mammadova/);
});

Deno.test("handlePublishedCommand: validation of invalid arguments or URL", async () => {
  const { handlePublishedCommand } = await import("./index.ts");
  // deno-lint-ignore no-explicit-any
  const dummySupabase = {} as any;

  // 1. Missing URL
  const resMissing = await handlePublishedCommand(dummySupabase, "fake_token", 12345, "5616503");
  assertEquals(resMissing.ok, false);
  assertEquals(resMissing.error, "invalid_arguments");

  // 2. Empty string
  const resEmpty = await handlePublishedCommand(dummySupabase, "fake_token", 12345, "   ");
  assertEquals(resEmpty.ok, false);
  assertEquals(resEmpty.error, "invalid_arguments");

  // 3. Invalid URL format (e.g. YouTube or generic link)
  const resInvalidUrl = await handlePublishedCommand(
    dummySupabase,
    "fake_token",
    12345,
    "5616503 https://youtube.com/watch?v=123",
  );
  assertEquals(resInvalidUrl.ok, false);
  assertEquals(resInvalidUrl.error, "invalid_url_format");
});

Deno.test("formatCockpitCardTelegram: formats card with WhatsApp, Act, and Dismiss buttons", () => {
  const payload: CockpitCardTelegramPayload = {
    id: "card-xyz-789",
    headline: "Təcili Qiymət Fürsəti",
    channel: "WHATSAPP",
    priority: "HIGH",
    reason: "Mülkiyyətçi 15 000 AZN endirim etdi",
    draft_text: "Salam, mənzilə baxış təyin edək?",
    sentinel_warning: "Dəqiq ünvan gizlədildi",
    owner_phone: "+994501234567",
  };

  const formatted = formatCockpitCardTelegram(payload);

  assertMatch(formatted.text, /🎯 <b>AI SATIŞ MƏŞVƏRƏT KARTI \(COCKPIT HUD\)<\/b>/);
  assertMatch(formatted.text, /⚡ <b>Prioritet:<\/b> 🟠 YÜKSƏK \| <b>Kanal:<\/b> 📱 WhatsApp/);
  assertMatch(formatted.text, /📌 <b>Başlıq:<\/b> <b>Təcili Qiymət Fürsəti<\/b>/);
  assertMatch(formatted.text, /💡 <b>Strategiya:<\/b> <i>Mülkiyyətçi 15 000 AZN endirim etdi<\/i>/);
  assertMatch(formatted.text, /⚠️ <b>Sentinel Qoruyucu:<\/b> <i>Dəqiq ünvan gizlədildi<\/i>/);
  assertMatch(formatted.text, /<code>Salam, mənzilə baxış təyin edək\?<\/code>/);

  const kb = formatted.reply_markup.inline_keyboard;
  assertEquals(kb.length, 2);
  assertEquals(kb[0][0].text, "💬 WhatsApp Sahibinə");
  assertEquals(kb[0][0].url, `https://wa.me/994501234567?text=${encodeURIComponent(payload.draft_text!)}`);
  assertEquals(kb[1][0].text, "🚀 Təsdiqlə");
  assertEquals(kb[1][0].callback_data, "cockpit_act_card-xyz-789");
  assertEquals(kb[1][1].text, "❌ Ləğv Et");
  assertEquals(kb[1][1].callback_data, "cockpit_dismiss_card-xyz-789");
});

