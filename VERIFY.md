# Verifying schema-envoy

This reproduces the five baselines in the README's Measured table from the published
package, in a clean directory. It does not require this repository to be checked out.

```bash
mkdir -p schema-envoy-verify && cd schema-envoy-verify
npm init -y >/dev/null 2>&1
npm install schema-envoy@latest >/dev/null 2>&1
npx schema-envoy --self-check
```

Expected output:

```text
B1 gemini.functionDeclarationParameters ok checked=720 agreed=648 widened=72 narrowed=0
B2 naive strict required-fill ok checked=12 agreed=1 widened=0 narrowed=11
B3 gemini.parametersJsonSchema ok checked=96 agreed=2 widened=94 narrowed=0
B4 oneOf read as anyOf ok checked=4 agreed=3 widened=1 narrowed=0
B5 openai.strict ok checked=72 agreed=36 widened=35 narrowed=1
```

Exit code 0 means every row reproduced.
