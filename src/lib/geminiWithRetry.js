const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isGeminiRateLimitError = (err) => {
  const code = err?.error?.code ?? err?.code ?? err?.status;
  const message = String(err?.message ?? err ?? "");

  return (
    Number(code) === 429 ||
    /RESOURCE_EXHAUSTED|rate\s*limit|too\s*many\s*requests|quota|429/i.test(message)
  );
};

async function geminiWithRetry(fn, options = {}) {
  const {
    retries = 5,
    iteration = 1,
    label = "gemini",
    logger = console,
  } = options;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    logger.log("Calling Gemini API", {
      label,
      iteration,
      attempt,
      timestamp: new Date().toISOString(),
    });

    try {
      return await fn();
    } catch (err) {
      const canRetry = attempt <= retries && isGeminiRateLimitError(err);
      if (!canRetry) throw err;

      const waitMs = Math.max(attempt * 15000, 8000);
      logger.warn(`Gemini rate limit hit. Waiting ${waitMs}ms before retry.`, {
        label,
        iteration,
        attempt,
      });
      await sleep(waitMs);
    }
  }

  throw new Error("Gemini rate limit exceeded after retries. Please try again later.");
}

export default geminiWithRetry;
