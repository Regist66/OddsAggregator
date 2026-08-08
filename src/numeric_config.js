export function numericOption(
  value,
  label,
  { integer = false, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {},
) {
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    (integer && !Number.isInteger(number)) ||
    number < min ||
    number > max
  ) {
    const range = `${min === Number.NEGATIVE_INFINITY ? "-∞" : min}..${
      max === Number.POSITIVE_INFINITY ? "∞" : max
    }`;
    throw new Error(
      `Érvénytelen numerikus beállítás (${label}=${value}); ` +
        `${integer ? "egész " : ""}érték szükséges, tartomány: ${range}.`,
    );
  }
  return number;
}

export function envNumber(name, fallback, constraints) {
  return numericOption(process.env[name] ?? fallback, name, constraints);
}

export function validateNamedArguments(
  knownNames,
  argv = process.argv.slice(2),
  booleanNames = [],
) {
  const known = new Set(knownNames.map(name => `--${name}`));
  const booleans = new Set(booleanNames.map(name => `--${name}`));
  const seen = new Set();
  for (let index = 0; index < argv.length;) {
    const flag = argv[index];
    if (!known.has(flag)) throw new Error(`Ismeretlen CLI kapcsoló: ${flag}`);
    if (seen.has(flag)) throw new Error(`Dupla CLI kapcsoló: ${flag}`);
    seen.add(flag);
    if (booleans.has(flag)) {
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Hiányzó érték a CLI kapcsoló után: ${flag}`);
    }
    index += 2;
  }
}
