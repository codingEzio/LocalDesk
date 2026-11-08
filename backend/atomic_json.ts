/** Write a complete JSON file using a private, exclusively created sibling. */
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const data = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await Deno.open(tmp, {
    write: true,
    createNew: true,
    mode: 0o600,
  });
  try {
    try {
      let offset = 0;
      while (offset < data.length) {
        const written = await file.write(data.subarray(offset));
        if (written === 0) {
          throw new Error("Failed to write JSON temporary file");
        }
        offset += written;
      }
    } finally {
      file.close();
    }
    await Deno.rename(tmp, path);
  } catch (error) {
    try {
      await Deno.remove(tmp);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Deno.errors.NotFound)) {
        throw new AggregateError(
          [error, cleanupError],
          "JSON write and cleanup failed",
        );
      }
    }
    throw error;
  }
}
