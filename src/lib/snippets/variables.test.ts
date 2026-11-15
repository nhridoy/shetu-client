import { describe, expect, it } from "vitest";
import { fillSnippet, snippetVariables } from "./variables";

describe("snippet variables", () => {
  it("finds each name once, in order, allowing spaces inside the braces", () => {
    expect(
      snippetVariables(
        "tail -n {{lines}} /var/log/{{ service }}.log {{lines}}",
      ),
    ).toEqual(["lines", "service"]);
    expect(snippetVariables("echo {{my-var_2}}")).toEqual(["my-var_2"]);
  });

  it("ignores text that isn't a variable", () => {
    expect(snippetVariables("docker ps")).toEqual([]);
    expect(snippetVariables("echo {{1bad}} {{}} { {x} } {{a b}}")).toEqual([]);
  });

  it("fills every occurrence and leaves non-variables as typed", () => {
    expect(
      fillSnippet("tail -n {{lines}} {{ service }}.log {{lines}} {{1bad}}", {
        lines: "50",
        service: "nginx",
      }),
    ).toBe("tail -n 50 nginx.log 50 {{1bad}}");
  });

  it("values are inserted literally, even with $ patterns", () => {
    expect(fillSnippet("echo {{x}}", { x: "$& $1" })).toBe("echo $& $1");
  });
});
