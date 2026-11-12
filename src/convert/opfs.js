// OPFS helpers for the import worker.

export async function removeEntry(dir, name) {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch {
    // not there
  }
}

// A worker that was just stopped can hold the file for a moment.
export async function syncAccess(handle) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await handle.createSyncAccessHandle();
    } catch (err) {
      if (err.name !== "NoModificationAllowedError" || attempt >= 30) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
