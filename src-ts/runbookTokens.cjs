// @ts-check

const stopWords = new Set((
  "a an the and or of to in on for from with by as at is are was were be been being " +
  "do does did how what why when where which who should would could can may must " +
  "i my we our you your it its this that these those there then than if after before " +
  "while during so but into out up again still only too not no have has had will " +
  "check investigate diagnose explain help mean relate set configure fix repair resolve"
).split(" "));

const variants = new Map([
  ["throttling", "throttle"], ["throttled", "throttle"], ["throttles", "throttle"],
  ["retries", "retry"], ["retried", "retry"], ["retrying", "retry"],
  ["failed", "failure"], ["failing", "failure"], ["failures", "failure"],
]);

/** @param {string} value */
function runbookTokens(value) {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => !stopWords.has(token))
    .map((token) => variants.get(token) ?? (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token));
}

exports.runbookTokens = runbookTokens;
