process.stdin.once("data", () => {
  const malformedJson = Buffer.from("{", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(malformedJson.byteLength, 0);
  process.stdout.write(Buffer.concat([header, malformedJson]));
});
process.stdin.resume();
