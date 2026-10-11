/** A realistic multi-file Git-style patch used by rendering tests. */
export const prettyPatch = `diff --git a/src/hello.ts b/src/hello.ts
index 83db48f..bf269f4 100644
--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,4 +1,5 @@
 const hello = "world";
-print("hello")
+// greet loudly
+console.log("hello", hello);
 export { hello };
diff --git a/src/index.ts b/src/index.ts
index 5e1c30a..9f2c1d3 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { hello } from "./hello";
-hello();
+import { log } from "./log";
+log(hello);
`;

/**
 * A REAL single-file unified patch, checked in as static data.
 *
 * Generated ONCE with `git diff --no-index --unified=3` from
 * `D:\PM\sorting_script.py` → `D:\PM\sorting_script_modified.py`. Git is a
 * one-off developer utility for this fixture and **never a dependency**: the app
 * and the tests only ever read this string. Nothing at test time shells out to
 * git, PowerShell, or any external diff tool, and the `diff` package is not used
 * to produce it.
 *
 * Regenerating is optional and developer-only:
 *   cd /d/PM && git diff --no-index --unified=3 -- sorting_script.py sorting_script_modified.py
 *
 * The hunk header is the real one — `@@ -86,3 +86,4 @@`. (An earlier
 * hand-written `@@ -85,5 +85,6 @@` was off by one; note that a wrong *count* can
 * make `parse-diff` reject the patch and silently fall through to the loose
 * parser, so this must stay the generated text.)
 */
export const sortingScriptPatch = `diff --git a/sorting_script.py b/sorting_script_modified.py
index 6fea74c..7419d9e 100644
--- a/sorting_script.py
+++ b/sorting_script_modified.py
@@ -86,3 +86,4 @@ numbers = list(map(int, user_input.split()))
 print(f"\\nOriginal array: {numbers}")
 sorted_array = sort_func(numbers.copy())
 print(f"Sorted array ({algorithm_name}): {sorted_array}")
+print('added line')
`;

/**
 * The same change with every unified-diff header removed, leaving only the
 * informal `+`/`-`/space content a model typically writes in a ```diff fence.
 * `parse-diff` rejects this; the `parseLooseDiff` fallback is what keeps it
 * visible. Static data, for the same reason as above.
 */
export const sortingScriptLoosePatch = ` print(f"\\nOriginal array: {numbers}")
 sorted_array = sort_func(numbers.copy())
 print(f"Sorted array ({algorithm_name}): {sorted_array}")
+print('added line')
`;
