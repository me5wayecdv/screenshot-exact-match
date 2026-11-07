/** Retry only Cloudflare D1's transient resource-window overload. */
export function isD1Overload(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /D1 DB is overloaded|D1_ERROR.*overloaded|too many resources consumed within a 10 second window/i.test(
    message,
  );
}

export async function retryD1Overload<T>(
  operation: () => Promise<T>,
  delays = [200, 400, 800],
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isD1Overload(error) || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
