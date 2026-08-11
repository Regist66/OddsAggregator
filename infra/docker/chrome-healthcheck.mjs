const expectedPages = [
  "https://sharpxch.com/player/sport/1",
  "https://www.tippmixpro.hu/hu/fogadas/i",
  "https://vegas.hu/sports/live",
];

try {
  const version = await fetch("http://127.0.0.1:9333/json/version");
  if (!version.ok) throw new Error(`CDP version HTTP ${version.status}`);

  const response = await fetch("http://127.0.0.1:9333/json");
  if (!response.ok) throw new Error(`CDP targets HTTP ${response.status}`);
  const targets = await response.json();
  const pages = targets.filter(target => target.type === "page");
  const missing = expectedPages.filter(
    expected => !pages.some(page => page.url?.startsWith(expected)),
  );
  if (missing.length > 0) throw new Error(`hiányzó oldalak: ${missing.join(", ")}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
