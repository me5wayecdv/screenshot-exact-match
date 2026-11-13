import "@testing-library/jest-dom/vitest";

// setup.ts runs in every test file's environment. The two node:sqlite
// tests run under `// @vitest-environment node`, where `window` does not
// exist, so the jsdom-only shims below must be guarded.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", {
    writable: true,
    value: () => {},
  });

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
