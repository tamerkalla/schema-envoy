# Verifying schema-envoy

```
npx --yes schema-envoy@latest --self-check
```

| baseline | corpus | agreed | widened | narrowed |
|---|---|---|---|---|
| B1 gemini.functionDeclarationParameters | 720 | 648 | 72 | 0 |
| B2 naive strict required-fill | 12 | 1 | 0 | 11 |
| B3 gemini.parametersJsonSchema | 96 | 2 | 94 | 0 |
| B4 oneOf read as anyOf | 4 | 3 | 1 | 0 |
| B5 openai.strict | 72 | 36 | 35 | 1 |

Exit code 0 means every row reproduced.
