#!/usr/bin/env node

/**
 * record-demo.mjs — Playwright script to record a Full HD demo of heed
 *
 * Scenes:
 * 1. App loads clean (no banners)
 * 2. Click record → visualizer bars animate
 * 3. Live transcript: 4 speakers, character by character
 * 4. Stop → processing pill
 * 5. AI Notes tab with buttons (Copy, template, Generate) + streaming text with scroll
 * 6. Navigate to Sessions → click session → add #tags
 *
 * Usage: bun run scripts/record-demo.mjs
 * Output: assets/demo.webm (Full HD 1920x1350)
 */

import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const WIDTH = 1920;
const HEIGHT = 1550;
const BASE = "http://localhost:5170";

const SPEAKERS = [
  { name: "Me", color: "#2563EB" },
  { name: "Sarah Chen", color: "#10B981" },
  { name: "Marcus Rivera", color: "#F59E0B" },
  { name: "Alex Kim", color: "#EF4444" },
];

const CONVERSATION = [
  { speaker: 1, text: "The Q3 numbers are in. We hit 142% of target across all regions." },
  { speaker: 0, text: "That's incredible. What drove the spike in LATAM?" },
  { speaker: 2, text: "Two things — the referral program we launched in August, and the partnership with Banco Nacional finally closing. That alone brought 340 new enterprise accounts." },
  { speaker: 3, text: "On the product side, the self-serve dashboard reduced onboarding time by 60%. Support tickets dropped from 2,300 to 890 per week." },
  { speaker: 1, text: "And the churn rate dropped to 2.1%, which is the lowest we've seen in eighteen months." },
  { speaker: 0, text: "Let's make sure we document what worked so we can replicate it in Q4." },
];

const AI_NOTES_LINES = [
  { type: "h2", text: "Q3 Performance Review — Key Takeaways" },
  { type: "br" },
  { type: "bold", text: "Overall Performance" },
  { type: "li", text: "Hit 142% of target across all regions" },
  { type: "li", text: "LATAM was the standout performer" },
  { type: "br" },
  { type: "bold", text: "Growth Drivers" },
  { type: "li", text: "Referral program (launched August) drove significant new signups" },
  { type: "li", text: "Banco Nacional partnership closed → 340 new enterprise accounts" },
  { type: "li", text: "Self-serve dashboard reduced onboarding time by 60%" },
  { type: "br" },
  { type: "bold", text: "Operational Improvements" },
  { type: "li", text: "Support tickets: 2,300 → 890/week (61% reduction)" },
  { type: "li", text: "Churn rate: dropped to 2.1% (18-month low)" },
  { type: "br" },
  { type: "bold", text: "Action Items" },
  { type: "check", text: "Document successful strategies for Q4 replication" },
  { type: "check", text: "Expand referral program to other regions" },
  { type: "check", text: "Share dashboard improvements with product team" },
];

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`[demo] Launching browser ${WIDTH}x${HEIGHT}...`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: "/tmp/heed-demo-video", size: { width: WIDTH, height: HEIGHT } },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();

  // Inject CSS animations early
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes blink { 0%,50% { opacity:1 } 51%,100% { opacity:0 } }
      @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
      @keyframes fadeIn { from { opacity:0;transform:translateY(4px) } to { opacity:1;transform:translateY(0) } }
    `;
    document.head.appendChild(style);
  });

  // ==================== SCENE 1: Load app ====================
  console.log("[demo] Loading app...");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(300);

  await page.evaluate(() => {
    localStorage.setItem("heed-tour-done", "1");
    localStorage.setItem("heed-setup-done", "1");
    localStorage.setItem("heed-locale", "en");
    localStorage.setItem("heed-language", "auto");
    localStorage.setItem("heed-recovery-dismissed", "1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await sleep(600);

  // Remove any recovery/banner elements
  await page.evaluate(() => {
    document.querySelectorAll("[class*='recovery'], [class*='Recovery'], [class*='banner'], [class*='Banner']").forEach((el) => {
      if (el.textContent?.includes("unprocessed") || el.textContent?.includes("recording")) el.remove();
    });
  });
  await sleep(200);

  // Set model chip
  await page.evaluate(() => {
    const chip = document.querySelector("[data-tour='model-chip']");
    if (chip) {
      const nameEl = chip.querySelector("[class*='modelChipName']") || chip.querySelector("span");
      if (nameEl) nameEl.textContent = "Gemma 4 31B";
    }
  });
  await sleep(1000);

  // ==================== SCENE 2: Record ====================
  console.log("[demo] Starting recording...");
  // DON'T click the real button — it tries to record and fails without audio devices
  // Mock the entire recording state visually
  await page.evaluate(() => {
    const btn = document.querySelector("[data-tour='record']");
    if (btn) {
      btn.style.border = "3px solid rgba(239, 68, 68, 0.3)";
      btn.style.background = "rgba(239, 68, 68, 0.08)";
      btn.style.boxShadow = "0 0 0 8px rgba(239,68,68,0.08)";
      const icon = btn.querySelector("div");
      if (icon) {
        icon.style.background = "#EF4444";
        icon.style.borderRadius = "4px";
        icon.style.width = "20px";
        icon.style.height = "20px";
      }
    }
    document.querySelectorAll("[class*='label']").forEach((el) => {
      if (el.textContent?.includes("Click to start") || el.textContent?.includes("click to")) {
        el.textContent = "Recording... click to stop";
      }
    });
  });

  // Bar animation — runs INSIDE the browser, reacts to who is speaking
  // window.__demoActiveSpeaker: "me" = mic bars active, "other" = system bars active, "idle" = both low
  console.log("[demo] Animating visualizer bars...");
  await page.evaluate(() => {
    window.__demoActiveSpeaker = "idle";
    let lastTimerTick = Date.now();
    window.__demoBarAnimation = setInterval(() => {
      const who = window.__demoActiveSpeaker || "idle";
      document.querySelectorAll("[class*='bar']").forEach((bar) => {
        const isSys = bar.style.background?.includes("16, 185, 129") || bar.className?.includes("System") || bar.style.backgroundColor?.includes("rgb(16, 185, 129)");
        let maxH, minH;
        if (isSys) {
          // System bars: strong when others speak, quiet when "me" speaks
          maxH = who === "other" ? 68 : who === "idle" ? 12 : 8;
          minH = who === "other" ? 15 : 3;
        } else {
          // Mic bars: strong when "me" speaks, quiet when others speak
          maxH = who === "me" ? 80 : who === "idle" ? 12 : 8;
          minH = who === "me" ? 18 : 3;
        }
        bar.style.height = Math.floor(Math.random() * (maxH - minH) + minH) + "px";
      });
      // Tick timer every ~1s
      const now = Date.now();
      if (now - lastTimerTick >= 1000) {
        lastTimerTick = now;
        document.querySelectorAll("*").forEach((el) => {
          if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 && /^\d{2}:\d{2}$/.test(el.textContent.trim())) {
            const [m, s] = el.textContent.trim().split(":").map(Number);
            const t = m * 60 + s + 1;
            el.textContent = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
          }
        });
      }
    }, 80);
  });

  await sleep(1200);

  // ==================== SCENE 3: Live transcript ====================
  console.log("[demo] Injecting live transcript...");

  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return;

    const card = document.createElement("div");
    card.id = "demo-result";
    card.style.cssText = "margin:0 auto;max-width:700px;padding:0 24px 40px;opacity:0;transition:opacity 0.5s";
    card.innerHTML = `
      <div style="display:flex;gap:8px;border-bottom:2px solid #2563EB;padding:8px 0;margin-bottom:16px">
        <span id="demo-tab-speakers" style="font-family:'Geist Mono',monospace;font-size:13px;font-weight:600;color:#2563EB;padding:6px 14px;cursor:pointer">Speakers</span>
        <span id="demo-tab-notes" style="font-family:'Geist Mono',monospace;font-size:13px;color:#94A3B8;padding:6px 14px;cursor:pointer">AI Notes</span>
      </div>
      <div id="demo-content" style="background:white;border:1px solid #E2E8F0;border-radius:12px;padding:20px;min-height:200px">
        <div style="font-size:10px;color:#94A3B8;font-family:'Geist Mono',monospace;margin-bottom:12px">Click to rename · Right-click to merge with another speaker</div>
        <div id="demo-chips" style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap"></div>
        <div id="demo-transcript" style="font-size:14px;line-height:1.8"></div>
      </div>
    `;
    main.appendChild(card);
    requestAnimationFrame(() => { card.style.opacity = "1"; });
  });

  await sleep(500);

  for (let i = 0; i < CONVERSATION.length; i++) {
    const line = CONVERSATION[i];
    const speaker = SPEAKERS[line.speaker];

    // Set active speaker for visualizer bars (0 = "Me" = mic, others = system)
    await page.evaluate(({ isMe }) => {
      window.__demoActiveSpeaker = isMe ? "me" : "other";
    }, { isMe: line.speaker === 0 });

    // Add chip
    await page.evaluate(({ sp, idx }) => {
      const chips = document.getElementById("demo-chips");
      if (!chips || chips.querySelector(`[data-speaker="${idx}"]`)) return;
      const chip = document.createElement("span");
      chip.setAttribute("data-speaker", idx);
      chip.style.cssText = "display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid #E2E8F0;border-radius:4px;font-family:'Geist Mono',monospace;font-size:11px;animation:fadeIn 0.3s ease";
      chip.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${sp.color};display:inline-block"></span> ${sp.name}`;
      chips.appendChild(chip);
    }, { sp: speaker, idx: line.speaker });

    // Speaker header
    await page.evaluate(({ sp }) => {
      const transcript = document.getElementById("demo-transcript");
      if (!transcript) return;
      const header = document.createElement("div");
      header.style.cssText = `margin-top:14px;font-weight:600;font-family:'Geist Mono',monospace;font-size:13px;color:${sp.color}`;
      header.textContent = sp.name;
      transcript.appendChild(header);
      const textEl = document.createElement("div");
      textEl.style.cssText = "padding-left:12px";
      textEl.id = "demo-current-line";
      transcript.appendChild(textEl);
    }, { sp: speaker });

    await sleep(150);

    // Typewriter
    const text = line.text;
    const charDelay = Math.max(6, Math.min(18, 1000 / text.length));
    for (let c = 0; c < text.length; c++) {
      await page.evaluate(({ partial }) => {
        const el = document.getElementById("demo-current-line");
        if (el) el.innerHTML = partial + '<span style="display:inline-block;width:2px;height:1em;background:#2563EB;margin-left:1px;vertical-align:text-bottom;animation:blink 1s infinite"></span>';
      }, { partial: text.slice(0, c + 1) });
      await sleep(charDelay);
    }

    await page.evaluate(({ final }) => {
      const el = document.getElementById("demo-current-line");
      if (el) el.textContent = final;
      el?.removeAttribute("id");
      // Brief idle between speakers
      window.__demoActiveSpeaker = "idle";
    }, { final: text });

    await sleep(250);
  }

  // Set to idle before stopping
  await page.evaluate(() => { window.__demoActiveSpeaker = "idle"; });
  await sleep(1200);

  // ==================== SCENE 4: Stop recording ====================
  console.log("[demo] Stopping recording...");

  await page.evaluate(() => {
    // Stop the in-browser bar animation
    if (window.__demoBarAnimation) clearInterval(window.__demoBarAnimation);
    document.querySelectorAll("[class*='bar']").forEach((bar) => {
      bar.style.height = "2px";
      bar.style.transition = "height 0.5s ease";
    });
    const btn = document.querySelector("[data-tour='record']");
    if (btn) {
      btn.style.border = "";
      btn.style.background = "";
      btn.style.boxShadow = "";
      const icon = btn.querySelector("div");
      if (icon) { icon.style.borderRadius = "50%"; icon.style.width = ""; icon.style.height = ""; }
    }
    document.querySelectorAll("[class*='label']").forEach((el) => {
      if (el.textContent?.includes("Recording")) {
        el.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:999px;padding:6px 16px;font-family:Geist Mono,monospace;font-size:12px;color:#64748B"><span style="width:6px;height:6px;border-radius:50%;background:#2563EB;animation:pulse 1.2s infinite"></span>Finalizing transcription...</span>';
      }
    });
  });

  await sleep(1800);

  // Reset label
  await page.evaluate(() => {
    document.querySelectorAll("[class*='label']").forEach((el) => {
      if (el.innerHTML?.includes("Finalizing")) el.textContent = "Click to start recording";
    });
  });

  // ==================== SCENE 5: AI Notes with buttons ====================
  console.log("[demo] Switching to AI Notes...");
  await sleep(600);

  await page.evaluate(() => {
    const tabSp = document.getElementById("demo-tab-speakers");
    const tabN = document.getElementById("demo-tab-notes");
    if (tabSp) { tabSp.style.color = "#94A3B8"; tabSp.style.fontWeight = "400"; }
    if (tabN) { tabN.style.color = "#2563EB"; tabN.style.fontWeight = "600"; }

    const content = document.getElementById("demo-content");
    if (content) {
      content.innerHTML = `
        <div id="demo-notes" style="font-size:14px;line-height:1.8;font-family:Inter,-apple-system,sans-serif;max-height:400px;overflow-y:auto;padding-right:8px"></div>
        <div id="demo-buttons" style="display:flex;gap:8px;align-items:center;margin-top:16px;padding-top:12px;border-top:1px solid #E2E8F0">
          <button style="padding:6px 14px;border:1px solid #E2E8F0;border-radius:6px;background:white;font-family:'Geist Mono',monospace;font-size:12px;color:#64748B;cursor:pointer">Copy</button>
          <select style="padding:6px 10px;border:1px solid #E2E8F0;border-radius:6px;background:white;font-family:'Geist Mono',monospace;font-size:12px;color:#334155;max-width:180px;cursor:pointer">
            <option>General Meeting</option>
            <option>Sales Call</option>
            <option>1-on-1</option>
            <option>Retrospective</option>
          </select>
          <button id="demo-generate-btn" style="padding:6px 14px;border:1px solid #E2E8F0;border-radius:6px;background:white;font-family:'Geist Mono',monospace;font-size:12px;color:#334155;cursor:pointer">Generate AI notes</button>
        </div>
      `;
    }
  });

  await sleep(600);

  // Click "Generate AI notes" button (visual feedback)
  await page.evaluate(() => {
    const btn = document.getElementById("demo-generate-btn");
    if (btn) {
      btn.style.background = "#F1F5F9";
      btn.textContent = "Generating...";
      btn.style.color = "#94A3B8";
    }
  });

  await sleep(400);

  // Stream AI notes with auto-scroll
  console.log("[demo] Streaming AI notes...");
  for (const item of AI_NOTES_LINES) {
    await page.evaluate(({ item }) => {
      const notes = document.getElementById("demo-notes");
      if (!notes) return;
      let html = "";
      switch (item.type) {
        case "h2": html = `<h2 style="font-size:18px;font-weight:700;margin:0 0 12px 0;color:#0F172A">${item.text}</h2>`; break;
        case "bold": html = `<div style="font-weight:600;margin-top:16px;margin-bottom:4px;color:#1E293B">${item.text}</div>`; break;
        case "li": html = `<div style="padding-left:8px;color:#475569">&bull; ${item.text}</div>`; break;
        case "check": html = `<div style="padding-left:8px;color:#475569"><input type="checkbox" disabled style="margin-right:6px">${item.text}</div>`; break;
        case "br": html = "<div style='height:8px'></div>"; break;
      }
      notes.innerHTML += html;
      notes.scrollTop = notes.scrollHeight;
    }, { item });
    await sleep(item.type === "h2" ? 200 : item.type === "br" ? 60 : 120);
  }

  // Update generate button to done
  await page.evaluate(() => {
    const btn = document.getElementById("demo-generate-btn");
    if (btn) { btn.textContent = "Generate AI notes"; btn.style.background = "white"; btn.style.color = "#334155"; }
  });

  await sleep(2000);

  // ==================== SCENE 6: Sessions → click → add tags ====================
  console.log("[demo] Navigating to Sessions...");

  // Click Sessions tab in nav
  await page.evaluate(() => {
    const sessionsTab = document.querySelector("[data-tour='sessions-tab']");
    if (sessionsTab) sessionsTab.click();
  });
  await sleep(800);

  // Inject a mock session card into the sessions list
  await page.evaluate(() => {
    // Find the sessions list container
    const main = document.querySelector("main");
    if (!main) return;

    // Clear main content and inject mock sessions page
    main.innerHTML = `
      <div style="max-width:700px;margin:0 auto;padding:24px">
        <div id="demo-session-card" style="background:white;border:1px solid #E2E8F0;border-radius:10px;padding:16px 20px;cursor:pointer;transition:border-color 0.2s;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div style="flex:1">
              <div style="font-family:'Geist Mono',monospace;font-size:13px;font-weight:600;color:#0F172A;margin-bottom:6px">
                Q3 Performance Review
              </div>
              <div style="font-size:12px;color:#64748B;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden">
                The Q3 numbers are in. We hit 142% of target across all regions...
              </div>
              <div style="font-family:'Geist Mono',monospace;font-size:10px;color:#94A3B8;display:flex;gap:12px">
                <span>4 speakers</span>
                <span>4:37</span>
                <span>Apr 13, 2026</span>
              </div>
            </div>
          </div>
        </div>
        <div style="background:white;border:1px solid #E2E8F0;border-radius:10px;padding:16px 20px;opacity:0.5">
          <div style="font-family:'Geist Mono',monospace;font-size:13px;font-weight:600;color:#0F172A;margin-bottom:6px">Team Standup — Frontend Sprint</div>
          <div style="font-size:12px;color:#64748B;margin-bottom:8px">Quick sync on the dashboard redesign progress...</div>
          <div style="font-family:'Geist Mono',monospace;font-size:10px;color:#94A3B8;display:flex;gap:12px">
            <span>2 speakers</span><span>12:05</span><span>Apr 12, 2026</span>
          </div>
        </div>
      </div>
    `;
  });

  await sleep(1000);

  // Hover effect on session card
  await page.evaluate(() => {
    const card = document.getElementById("demo-session-card");
    if (card) card.style.borderColor = "#2563EB";
  });
  await sleep(500);

  // Click → open session detail
  console.log("[demo] Opening session detail...");
  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return;

    main.innerHTML = `
      <div style="max-width:700px;margin:0 auto;padding:24px">
        <button id="demo-back" style="font-family:'Geist Mono',monospace;font-size:12px;color:#64748B;background:none;border:none;cursor:pointer;margin-bottom:16px">← Back</button>
        <div style="margin-bottom:8px">
          <input id="demo-title-input" type="text" value="Q3 Performance Review" style="font-family:'Geist Mono',monospace;font-size:18px;font-weight:700;color:#0F172A;border:none;outline:none;width:100%;background:transparent" />
        </div>
        <div style="font-family:'Geist Mono',monospace;font-size:10px;color:#94A3B8;margin-bottom:12px;display:flex;gap:12px">
          <span>4 speakers</span><span>4:37</span><span>Apr 13, 2026</span>
        </div>
        <div id="demo-tags-row" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;min-height:24px"></div>
        <div style="display:flex;gap:8px;border-bottom:2px solid #2563EB;padding:8px 0;margin-bottom:16px">
          <span style="font-family:'Geist Mono',monospace;font-size:13px;font-weight:600;color:#2563EB;padding:6px 14px">Speakers</span>
          <span style="font-family:'Geist Mono',monospace;font-size:13px;color:#94A3B8;padding:6px 14px">AI Notes</span>
        </div>
        <div style="background:white;border:1px solid #E2E8F0;border-radius:12px;padding:20px">
          <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap">
            <span style="display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid #E2E8F0;border-radius:4px;font-family:'Geist Mono',monospace;font-size:11px"><span style="width:8px;height:8px;border-radius:50%;background:#2563EB;display:inline-block"></span> Me</span>
            <span style="display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid #E2E8F0;border-radius:4px;font-family:'Geist Mono',monospace;font-size:11px"><span style="width:8px;height:8px;border-radius:50%;background:#10B981;display:inline-block"></span> Sarah Chen</span>
            <span style="display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid #E2E8F0;border-radius:4px;font-family:'Geist Mono',monospace;font-size:11px"><span style="width:8px;height:8px;border-radius:50%;background:#F59E0B;display:inline-block"></span> Marcus Rivera</span>
            <span style="display:flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid #E2E8F0;border-radius:4px;font-family:'Geist Mono',monospace;font-size:11px"><span style="width:8px;height:8px;border-radius:50%;background:#EF4444;display:inline-block"></span> Alex Kim</span>
          </div>
          <div style="font-size:14px;line-height:1.8">
            <div style="margin-top:14px;font-weight:600;font-family:'Geist Mono',monospace;font-size:13px;color:#10B981">Sarah Chen</div>
            <div style="padding-left:12px">The Q3 numbers are in. We hit 142% of target across all regions.</div>
            <div style="margin-top:14px;font-weight:600;font-family:'Geist Mono',monospace;font-size:13px;color:#2563EB">Me</div>
            <div style="padding-left:12px">That's incredible. What drove the spike in LATAM?</div>
            <div style="margin-top:14px;font-weight:600;font-family:'Geist Mono',monospace;font-size:13px;color:#F59E0B">Marcus Rivera</div>
            <div style="padding-left:12px">Two things — the referral program we launched in August, and the partnership with Banco Nacional finally closing.</div>
          </div>
        </div>
      </div>
    `;
  });

  await sleep(1000);

  // Type tags into title using # autocomplete
  console.log("[demo] Adding #tags...");

  // --- Tag 1: Create NEW tag "quarterly" ---
  await page.evaluate(() => {
    const input = document.getElementById("demo-title-input");
    if (input) { input.style.caretColor = "#2563EB"; input.focus(); }
  });
  await sleep(300);

  // Type "#quarterly" character by character
  const newTag = "#quarterly";
  for (let i = 0; i < newTag.length; i++) {
    await page.evaluate(({ text }) => {
      const input = document.getElementById("demo-title-input");
      if (input) input.value = "Q3 Performance Review " + text;
    }, { text: newTag.slice(0, i + 1) });

    // Show dropdown after typing "#q"
    if (i === 1) {
      await page.evaluate(() => {
        const input = document.getElementById("demo-title-input");
        if (!input) return;
        const rect = input.getBoundingClientRect();
        const dropdown = document.createElement("div");
        dropdown.id = "demo-tag-dropdown";
        dropdown.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left + 280}px;min-width:200px;max-height:240px;background:white;border:1px solid #E2E8F0;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.08);z-index:200;padding:4px`;
        dropdown.innerHTML = `
          <div style="padding:8px 12px;font-family:'Geist Mono',monospace;font-size:12px;color:#334155;border-radius:4px;cursor:pointer;background:#EFF6FF">#quarterly <span style="font-size:10px;color:#10B981;margin-left:4px">new</span></div>
        `;
        document.body.appendChild(dropdown);
      });
    }

    // Update dropdown as user types more
    if (i > 1 && i < newTag.length - 1) {
      await page.evaluate(({ partial }) => {
        const dd = document.getElementById("demo-tag-dropdown");
        if (dd) {
          dd.innerHTML = `<div style="padding:8px 12px;font-family:'Geist Mono',monospace;font-size:12px;color:#334155;border-radius:4px;cursor:pointer;background:#EFF6FF">${partial} <span style="font-size:10px;color:#10B981;margin-left:4px">new</span></div>`;
        }
      }, { partial: newTag.slice(0, i + 1) });
    }

    await sleep(60);
  }

  await sleep(500);

  // Select the new tag (Enter)
  await page.evaluate(() => {
    const dropdown = document.getElementById("demo-tag-dropdown");
    if (dropdown) dropdown.remove();
    const input = document.getElementById("demo-title-input");
    if (input) input.value = "Q3 Performance Review";
    const tagsRow = document.getElementById("demo-tags-row");
    if (tagsRow) {
      tagsRow.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:#EFF6FF;color:#0066ff;border-radius:10px;font-family:'Geist Mono',monospace;font-size:10px;animation:fadeIn 0.3s ease">#quarterly <span style="cursor:pointer;color:#94A3B8;font-size:8px">×</span></span>`;
    }
  });

  await sleep(800);

  // --- Tag 2: Select EXISTING tag from dropdown ---
  await page.evaluate(() => {
    const input = document.getElementById("demo-title-input");
    if (input) { input.value = "Q3 Performance Review #"; input.focus(); }
  });
  await sleep(300);

  // Show dropdown with existing tags
  await page.evaluate(() => {
    const input = document.getElementById("demo-title-input");
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const dropdown = document.createElement("div");
    dropdown.id = "demo-tag-dropdown2";
    dropdown.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left + 280}px;min-width:200px;background:white;border:1px solid #E2E8F0;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.08);z-index:200;padding:4px`;
    dropdown.innerHTML = `
      <div style="padding:8px 12px;font-family:'Geist Mono',monospace;font-size:12px;color:#334155;border-radius:4px;cursor:pointer;background:#EFF6FF">#sales</div>
      <div style="padding:8px 12px;font-family:'Geist Mono',monospace;font-size:12px;color:#334155;border-radius:4px;cursor:pointer">#latam</div>
      <div style="padding:8px 12px;font-family:'Geist Mono',monospace;font-size:12px;color:#334155;border-radius:4px;cursor:pointer">#team-sync</div>
      <div style="padding:8px 12px;font-family:'Geist Mono',monospace;font-size:12px;color:#334155;border-radius:4px;cursor:pointer">#quarterly</div>
    `;
    document.body.appendChild(dropdown);
  });

  await sleep(1000);

  // Highlight "sales" option
  await page.evaluate(() => {
    const dd = document.getElementById("demo-tag-dropdown2");
    if (dd) {
      const first = dd.querySelector("div");
      if (first) first.style.background = "#DBEAFE";
    }
  });

  await sleep(500);

  // Select "sales"
  await page.evaluate(() => {
    const dropdown = document.getElementById("demo-tag-dropdown2");
    if (dropdown) dropdown.remove();
    const input = document.getElementById("demo-title-input");
    if (input) { input.value = "Q3 Performance Review"; input.blur(); }
    const tagsRow = document.getElementById("demo-tags-row");
    if (tagsRow) {
      tagsRow.innerHTML = `
        <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:#EFF6FF;color:#0066ff;border-radius:10px;font-family:'Geist Mono',monospace;font-size:10px">#quarterly <span style="cursor:pointer;color:#94A3B8;font-size:8px">×</span></span>
        <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:#EFF6FF;color:#0066ff;border-radius:10px;font-family:'Geist Mono',monospace;font-size:10px;animation:fadeIn 0.3s ease">#sales <span style="cursor:pointer;color:#94A3B8;font-size:8px">×</span></span>
      `;
    }
  });

  await sleep(2500);

  // ==================== DONE ====================
  console.log("[demo] Closing browser and saving video...");
  await page.close();
  await context.close();
  await browser.close();

  const videoFiles = execSync("ls -t /tmp/heed-demo-video/*.webm 2>/dev/null").toString().trim().split("\n");
  const videoPath = videoFiles[0];

  if (!videoPath || !existsSync(videoPath)) {
    console.error("[demo] No video file found!");
    process.exit(1);
  }

  console.log(`[demo] Video saved: ${videoPath}`);

  // Copy to assets
  const webmPath = "/home/junrod/Desktop/heed/assets/demo.webm";
  execSync(`cp "${videoPath}" "${webmPath}"`);

  const size = execSync(`du -h "${webmPath}"`).toString().trim();
  console.log(`[demo] WebM: ${webmPath} (${size.split("\t")[0]})`);

  // Also generate GIF (scaled to 960 for manageable size)
  const gifPath = "/home/junrod/Desktop/heed/assets/demo.gif";
  console.log("[demo] Converting to GIF...");
  execSync(
    `ffmpeg -y -i "${videoPath}" -vf "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${gifPath}"`,
    { stdio: "inherit" }
  );
  const gifSize = execSync(`du -h "${gifPath}"`).toString().trim();
  console.log(`[demo] GIF: ${gifPath} (${gifSize.split("\t")[0]})`);

  console.log("\n[demo] Done! Preview assets/demo.webm before committing.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
