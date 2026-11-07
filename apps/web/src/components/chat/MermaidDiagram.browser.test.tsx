import { describe, expect, it } from "vite-plus/test";

import { sanitizeDiagramSvg, sanitizeMathDiagramSvg } from "./MermaidDiagram";

// The label markup pele emits for $$...$$ text.
function mathLabelSvg(label: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><foreignObject height="34" width="35" x="57" y="85"><div xmlns="http://www.w3.org/1999/xhtml">${label}</div></foreignObject></svg>`;
}

function mount(fragment: Node) {
  const host = document.createElement("div");
  host.append(fragment);
  return host;
}

describe("sanitizeMathDiagramSvg", () => {
  it("keeps the MathML KaTeX renders for math labels", () => {
    const host = mount(
      sanitizeMathDiagramSvg(
        mathLabelSvg(
          '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><mfrac><mi>d</mi><mrow><mi>d</mi><mi>x</mi></mrow></mfrac><mrow><mo fence="true">(</mo><mi mathvariant="bold">v</mi><mo fence="true">)</mo></mrow><msqrt><mn>2</mn></msqrt></mrow></math>',
        ),
      ),
    );

    const math = host.querySelector("foreignObject math");
    expect(math?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(math?.getAttribute("display")).toBe("block");
    expect(math?.querySelector("mfrac")?.textContent).toBe("ddx");
    expect(math?.querySelector("msqrt")?.textContent).toBe("2");
    expect(math?.querySelector("mi[mathvariant='bold']")?.textContent).toBe("v");
    expect(math?.querySelectorAll("mo[fence='true']")).toHaveLength(2);
  });

  it("strips links, scripts, and MathML outside what KaTeX emits", () => {
    const host = mount(
      sanitizeMathDiagramSvg(
        mathLabelSvg(
          '<math href="javascript:alert(1)"><mi href="javascript:alert(1)" onclick="alert(1)">x</mi><maction actiontype="toggle"><mi>a</mi></maction><mglyph src="https://example.com/a.png"></mglyph><annotation-xml encoding="text/html"><img src="x" onerror="alert(1)"></annotation-xml><semantics><mi>y</mi><annotation encoding="application/x-tex">y</annotation></semantics></math><a href="https://example.com">link</a><script>alert(1)</script>',
        ),
      ),
    );

    const math = host.querySelector("math");
    expect(math).not.toBeNull();
    expect(math?.querySelector("mi")?.textContent).toBe("x");
    expect(host.querySelector("[href], [onclick], [src], [onerror]")).toBeNull();
    expect(
      host.querySelector("maction, mglyph, annotation-xml, annotation, img, a, script"),
    ).toBeNull();
  });

  it("only accepts math as an HTML label and keeps its attributes on MathML", () => {
    const host = mount(
      sanitizeMathDiagramSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><math><mi>x</mi></math><text mathvariant="bold" fence="true">label</text></svg>',
      ),
    );

    expect(host.querySelector("math, mi")).toBeNull();
    expect(host.querySelector("text")?.getAttributeNames()).toEqual([]);
  });
});

describe("sanitizeDiagramSvg", () => {
  it("strips links, images, styles, foreign content, and handlers", () => {
    const host = mount(
      sanitizeDiagramSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a href="javascript:alert(1)"><text>go</text></a><image href="https://example.com/a.png" xlink:href="https://example.com/b.png"></image><style>*{background:url(https://example.com)}</style><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject><use xlink:href="#x"></use><rect onclick="alert(1)" onload="alert(1)" width="10" height="10"></rect><script>alert(1)</script><text>label</text></svg>',
      ),
    );

    expect(host.querySelector("svg")).not.toBeNull();
    expect(host.querySelector("rect")?.getAttribute("width")).toBe("10");
    expect(host.querySelector("a, image, style, foreignObject, div, script")).toBeNull();
    expect(host.querySelector("[href], [onclick], [onload]")).toBeNull();
    const hrefs = [...host.querySelectorAll("*")].flatMap((element) =>
      element.getAttributeNames().filter((name) => name.endsWith("href")),
    );
    expect(hrefs).toEqual([]);
    expect(host.textContent).toContain("label");
  });
});
