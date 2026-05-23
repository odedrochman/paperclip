import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, redactSensitiveText, sanitizeRecord } from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values; ROC-52 Option A — env is a sensitive bag", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        // ROC-52: PAPERCLIP_API_URL would previously have passed
        // through because its key name doesn't match SECRET_PAYLOAD_KEY_RE.
        // Under Option A all plain values under `env` are now redacted
        // regardless of the var name, because non-secret config should
        // not live in env in the first place.
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      // ROC-52 Option A: now redacted (was previously plain).
      PAPERCLIP_API_URL: REDACTED_EVENT_VALUE,
    });
  });

  it("ROC-52 Option A: redacts env vars with non-standard key names (NOTION_INTEGRATION, CUSTOM_CRED, etc.)", () => {
    const input = {
      env: {
        NOTION_INTEGRATION: "secret-integration-token",
        MY_ORG_TOKEN: "another-secret-value",
        CUSTOM_CRED: "yet-another",
        // Even seemingly benign string values get redacted under Option A
        // because env is treated as a secret bag.
        BASE_URL: "https://api.example.com",
      },
    };

    const result = sanitizeRecord(input);
    expect(result.env).toEqual({
      NOTION_INTEGRATION: REDACTED_EVENT_VALUE,
      MY_ORG_TOKEN: REDACTED_EVENT_VALUE,
      CUSTOM_CRED: REDACTED_EVENT_VALUE,
      BASE_URL: REDACTED_EVENT_VALUE,
    });
  });

  it("ROC-52 Option A: secret_ref bindings in env still pass through with the secretId intact", () => {
    const input = {
      env: {
        OPENAI_API_KEY: {
          type: "secret_ref",
          secretId: "22222222-2222-2222-2222-222222222222",
          version: 3,
        },
        ANTHROPIC_API_KEY: {
          type: "secret_ref",
          secretId: "33333333-3333-3333-3333-333333333333",
        },
        // null preserved for shape inspection
        EMPTY_VAR: null,
      },
    };

    const result = sanitizeRecord(input);
    expect(result.env).toEqual({
      OPENAI_API_KEY: {
        type: "secret_ref",
        secretId: "22222222-2222-2222-2222-222222222222",
        version: 3,
      },
      ANTHROPIC_API_KEY: {
        type: "secret_ref",
        secretId: "33333333-3333-3333-3333-333333333333",
      },
      EMPTY_VAR: null,
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command: "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: ["--safe", "ok", "--token", "ghp_arg_secret", "--api-key=sk-inline-example"],
      env: {
        PAPERCLIP_RESOLVED_COMMAND: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    // ROC-52 Option A: env is a sensitive bag. Both PAPERCLIP_RESOLVED_COMMAND
    // and SAFE_VALUE now fully redact instead of partial-redact or pass-through.
    // The outer `command` / `commandArgs` paths above still apply their own
    // text/arg redaction because those keys are at the top level, not inside env.
    // If command-line observability is needed for an agent, move that field
    // out of the env block in the payload.
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND: REDACTED_EVENT_VALUE,
      SAFE_VALUE: REDACTED_EVENT_VALUE,
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual(["--api-key", REDACTED_EVENT_VALUE, "safe-next"]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });
});
