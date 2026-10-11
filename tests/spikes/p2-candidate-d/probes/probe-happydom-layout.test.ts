/** SPIKE — probe happy-dom layout capabilities needed for the scroll proof. TEMPORARY. */
import { describe, expect, it } from "bun:test";

describe("happy-dom layout probe", () => {
  it("reports scroll/layout properties", () => {
    const viewport = document.createElement("div");
    viewport.style.overflow = "auto";
    const child = document.createElement("div");
    child.style.height = "120px";
    viewport.append(child);
    document.body.append(viewport);

    const probe = {
      viewportScrollHeight: viewport.scrollHeight,
      viewportClientHeight: viewport.clientHeight,
      viewportScrollTop: viewport.scrollTop,
      childOffsetHeight: child.offsetHeight,
      childOffsetTop: child.offsetTop,
      childScrollHeight: child.scrollHeight,
      hasScrollTo: typeof viewport.scrollTo,
      hasResizeObserver: typeof globalThis.ResizeObserver,
      hasRAF: typeof globalThis.requestAnimationFrame,
      hasIntersectionObserver: typeof globalThis.IntersectionObserver,
    };
    console.log("\n=== happy-dom layout probe ===");
    console.log(" ", JSON.stringify(probe, null, 0));

    // scrollTop is settable?
    viewport.scrollTop = 50;
    console.log("  scrollTop after set:", viewport.scrollTop);
    viewport.scrollTo?.({ top: 70 });
    console.log("  scrollTop after scrollTo:", viewport.scrollTop);

    // ResizeObserver functional?
    let roFired = false;
    try {
      const ro = new ResizeObserver(() => {
        roFired = true;
      });
      ro.observe(viewport);
      ro.disconnect();
    } catch (e) {
      console.log("  ResizeObserver error:", String(e));
    }
    console.log("  roFired:", roFired);

    expect(true).toBe(true);
  });
});
