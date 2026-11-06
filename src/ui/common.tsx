/** Saves `data` as a JSON file. Only ever called from an explicit user click. */
export function downloadJson(filename: string, data: unknown) {
  downloadText(filename, JSON.stringify(data, null, 2));
}

/** Saves text that is already serialised (an encrypted keystore). Only ever called from a user click. */
export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // The browser fetches the blob after this task; revoking at once can fail the download, and for a new
  // gas keystore that file is the only copy of the key. A minute is far longer than a local blob needs.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
