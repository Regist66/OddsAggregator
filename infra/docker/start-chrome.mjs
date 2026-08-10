import { spawn } from "node:child_process";

const cdpBaseUrl = "http://127.0.0.1:9333";
const pages = [
  "https://sharpxch.com/player/sport/1",
  "https://www.tippmixpro.hu/hu/fogadas/i",
  "https://vegas.hu/sports/live",
];

const chrome = spawn("chromium", [
  "--headless=new",
  "--no-sandbox",
  "--user-data-dir=/chrome-profile",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=9333",
  "--remote-allow-origins=*",
  "--proxy-server=socks5://127.0.0.1:1080",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  pages[0],
], { stdio: "inherit" });

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function getTargets() {
  const response = await fetch(`${cdpBaseUrl}/json`);
  if (!response.ok) throw new Error(`CDP target lekérés sikertelen: ${response.status}`);
  return response.json();
}

async function waitForCdp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpBaseUrl}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome még indul.
    }
    await sleep(500);
  }
  throw new Error("A Chrome CDP végpont 30 másodpercen belül nem vált elérhetővé.");
}

async function openMissingPages() {
  const targets = await getTargets();
  for (const url of pages.slice(1)) {
    if (targets.some(target => target.type === "page" && target.url?.startsWith(url))) continue;
    const response = await fetch(`${cdpBaseUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!response.ok) throw new Error(`CDP oldalnyitás sikertelen: ${url} (${response.status})`);
  }
}

chrome.once("error", error => {
  console.error(`Chrome indítási hiba: ${error.message}`);
  process.exitCode = 1;
});
chrome.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

try {
  await waitForCdp();
  await openMissingPages();
} catch (error) {
  console.error(error.message);
  chrome.kill("SIGTERM");
  process.exitCode = 1;
}
