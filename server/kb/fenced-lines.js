// Share fence boundaries between heading recognition, line wrapping and chunking.
function* fencedLines(text) {
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const opening = !fence && !!marker;
    const closing = !!(fence && marker && marker[1][0] === fence[0]
      && marker[1].length >= fence.length && !marker[2].trim());
    const code = !!fence || opening;
    if (opening) fence = marker[1];
    else if (closing) fence = null;
    yield { line, code, opening, closing };
  }
}

module.exports = { fencedLines };
