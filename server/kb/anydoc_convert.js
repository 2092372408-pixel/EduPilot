const { toMarkdown } = require('@firecrawl/anydoc');

toMarkdown(process.argv[2])
  .then((markdown) => process.stdout.write(markdown))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
