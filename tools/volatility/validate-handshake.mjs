import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv2020Import = require("ajv/dist/2020");
const Ajv2020 = Ajv2020Import?.default ?? Ajv2020Import;

const ajv = new Ajv2020({ allErrors: true });

const compiledBySchema = new WeakMap();

export function validateHandshake(handshakeJson, schemaJson) {
  let validate = compiledBySchema.get(schemaJson);
  if (!validate) {
    validate = ajv.compile(schemaJson);
    compiledBySchema.set(schemaJson, validate);
  }
  const ok = validate(handshakeJson);
  return { ok: !!ok, errors: validate.errors || [] };
}

if (process.argv[1]?.endsWith("validate-handshake.mjs")) {
  const handshakePath = process.argv[2];
  const schemaPath = process.argv[3] || ".mk2/handshake.schema.json";
  if (!handshakePath) {
    console.error("Usage: node validate-handshake.mjs <handshake.json> [schema.json]");
    process.exit(2);
  }
  const handshake = JSON.parse(readFileSync(handshakePath, "utf8"));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const { ok, errors } = validateHandshake(handshake, schema);
  if (!ok) {
    console.error("Handshake invalid:", errors);
    process.exit(1);
  }
  console.log("Handshake valid.");
}
