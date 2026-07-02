// Smoke suite for the mock-backend browser mode — the template for driving the
// app after a UI change (see CLAUDE.md › Testing changes in the running app).
// Each test gets a fresh browser context (fresh localStorage), which the mock
// seeds with one repo ("trickshot": main + feature/streaming worktrees). The
// fake agent's keyword triggers ("tool", "question", "permission", "crash", …)
// are defined in src/lib/mockBackend.ts › runTurn.
import { expect, type Page, test } from "@playwright/test";

/** Select a worktree row in the sidebar and wait for its chat to be usable. */
async function selectWorktree(page: Page, branch: string) {
  await page.locator(".wt-row", { hasText: branch }).click();
  await expect(page.locator("textarea")).toBeEnabled();
}

async function sendMessage(page: Page, text: string) {
  await page.locator("textarea").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("boots with the seeded repo and its worktrees", async ({ page }) => {
  await expect(page.locator(".repo-name")).toHaveText("trickshot");
  await expect(page.locator(".wt-row", { hasText: "main" })).toBeVisible();
  await expect(page.locator(".wt-row", { hasText: "feature/streaming" })).toBeVisible();
});

test("selecting a worktree starts a session and chat round-trips", async ({ page }) => {
  await selectWorktree(page, "feature/streaming");
  await expect(page.locator(".workspace-label .path")).toContainText("feature-streaming");

  await sendMessage(page, "hello there");
  await expect(page.locator(".msg.user")).toContainText("hello there");
  await expect(page.locator(".msg.assistant").last()).toContainText('received: "hello there"');

  // turn_end on the selected worktree fetches suggested replies (mock chips).
  await expect(page.locator(".suggestions button").first()).toBeVisible();
});

test("tool calls render as a collapsible group with results", async ({ page }) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "please use a tool");

  // Two consecutive calls collapse into one "2 tool calls" run; expand it.
  await page.getByText("2 tool calls").click();
  await expect(page.getByText("Reading")).toBeVisible();
  await expect(page.getByText("Running command")).toBeVisible();
  await expect(page.locator(".msg.assistant").last()).toContainText("all green");
});

test("the agent's question surfaces the modal; single + multiSelect answers resume the turn", async ({
  page,
}) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "ask me a question first");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Which database should the feature use?");
  // Submit stays disabled until EVERY question has at least one choice.
  await dialog.getByRole("button", { name: "Postgres" }).click();
  await expect(dialog.getByRole("button", { name: "Submit" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Auth" }).click();
  await dialog.getByRole("button", { name: "Export" }).click();
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".msg.assistant").last()).toContainText("Postgres; Auth, Export");
});

test("skipping the agent's question answers empty and the turn still completes", async ({
  page,
}) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "one question please");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Skip" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".msg.assistant").last()).toContainText("No answer given");
});

test("a permission request surfaces Allow/Deny and Allow resumes the turn", async ({ page }) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "this needs permission");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Allow");
  await dialog.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.locator(".msg.assistant").last()).toContainText("Permission granted");
});

test("denying a permission request skips the tool and completes the turn", async ({ page }) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "this needs permission");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Deny" }).click();
  await expect(page.locator(".msg.assistant").last()).toContainText("Permission denied");
});

test("Stop interrupts a streaming turn and the session returns to ready", async ({ page }) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "burst"); // ~3s of streamed tool pairs
  // Interrupt mid-stream: Stop replaces Send while a turn is in flight.
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  // The stream actually halts: the message count settles and stays put.
  await page.waitForTimeout(400);
  const settled = await page.locator(".tool-row").count();
  await page.waitForTimeout(400);
  expect(await page.locator(".tool-row").count()).toBe(settled);
});

test("an in-band agent error renders a bubble and the turn still completes", async ({ page }) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "fail once please");
  await expect(page.locator(".msg.error")).toContainText("went wrong mid-turn");
  await expect(page.locator(".msg.assistant").last()).toContainText("recovered");
  // The turn ended (not stuck busy): the composer can send again.
  await page.locator("textarea").fill("still alive?");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("git flow: stage all + commit clears the panel", async ({ page }) => {
  await selectWorktree(page, "main");
  await page.getByRole("button", { name: "+8" }).click();
  await expect(page.getByRole("button", { name: "src/lib/api.ts" })).toBeVisible();
  await page.getByRole("button", { name: "Stage all" }).click();
  await page.getByRole("textbox", { name: "Commit message…" }).fill("mock: ship it");
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  // The always-dirty fixture is cleared by commit; the file rows disappear.
  await expect(page.getByRole("button", { name: "src/lib/api.ts" })).toHaveCount(0);
});

test("worktree lifecycle: create (auto-selects), then remove-dirty with confirm", async ({
  page,
}) => {
  await selectWorktree(page, "main");
  await page.getByRole("button", { name: "New worktree" }).click();
  await page.getByPlaceholder("branch name…  (Enter)").fill("feature/e2e-created");
  await page.getByPlaceholder("branch name…  (Enter)").press("Enter");
  // The new worktree appears and becomes the selection.
  const row = page.locator(".wt-row", { hasText: "feature/e2e-created" });
  await expect(row).toBeVisible();
  await expect(page.locator(".workspace-label .path")).toContainText("feature-e2e-created");

  // Removing it hits the dirty-worktree confirm (the mock fixture is always dirty).
  await row.hover();
  await row.getByRole("button", { name: "×" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("uncommitted");
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toHaveCount(0);
  // The removed worktree's selection is cleared, not left dangling.
  await expect(page.locator(".workspace-label")).toContainText("select or create");
});

test("typing / opens the slash-command palette and picks a command", async ({ page }) => {
  await selectWorktree(page, "main");
  await page.locator("textarea").fill("/rev");
  const palette = page.getByRole("button", { name: "/review" });
  await expect(palette).toContainText("Review the current diff");
  await palette.click();
  await expect(page.locator("textarea")).toHaveValue("/review ");
});

test("the Changes tab shows the worktree's diff", async ({ page }) => {
  await selectWorktree(page, "main");
  // The mock worktree is always dirty (2 files, +8/−2), so the diffstat toggle
  // appears once the status fetch lands.
  await page.getByRole("button", { name: "+8" }).click();
  await page.getByRole("button", { name: "src/lib/api.ts" }).click();
  await expect(page.getByText("mock diff line for the E2E harness")).toBeVisible();
});

test("a sidecar crash surfaces the stderr tail, and re-selecting recovers", async ({ page }) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "crash please");
  await expect(page.locator(".msg.error")).toContainText("simulated sidecar panic");
  // Recovery: selecting the worktree again restarts a fresh session (ensureSession
  // is the same path as launch-resume) and chat works again.
  await selectWorktree(page, "main");
  await sendMessage(page, "back again");
  await expect(page.locator(".msg.assistant").last()).toContainText("back again");
});

test("chat survives a reload: the transcript rehydrates AND the session resumes by id", async ({
  page,
}) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "remember me");
  await expect(page.locator(".msg.assistant").last()).toContainText("remember me");
  // The transcript persists on a 600ms idle debounce — let it settle, then reload.
  await page.waitForTimeout(900);
  await page.reload();
  // Both restart mechanisms must hold (CLAUDE.md › Persistence): the rendered
  // history comes back from localStorage…
  await expect(page.locator(".msg.user")).toContainText("remember me");
  await expect(page.locator(".msg.assistant").last()).toContainText("remember me");
  // …and the relaunched session carries the prior session id so the agent's
  // context resumes too. (Post-reload the mock's start log is fresh.)
  // Cast: the spec runs outside the app's TS project, so the window global is untyped here.
  const starts = await page.evaluate(() => (window as any).__trickshotMock.sessionStarts);
  expect(starts.length).toBeGreaterThan(0);
  expect(starts[0].config.resumeSessionId).toBe("mock-session-1");
  // New turns still render after rehydration (rehydrated __keys must stay unique).
  await sendMessage(page, "and again");
  await expect(page.locator(".msg.assistant").last()).toContainText("and again");
});

test("concurrent worktrees: events route to their own transcript; background turns badge + notify", async ({
  page,
}) => {
  await selectWorktree(page, "main");
  await sendMessage(page, "hello main");
  await expect(page.locator(".msg.assistant").last()).toContainText("hello main");

  // Kick a long streamed turn (~3s), then switch away while it runs.
  await sendMessage(page, "burst");
  await selectWorktree(page, "feature/streaming");

  // main's in-flight stream must not bleed into this worktree's transcript.
  await expect(page.locator(".msg.user")).toHaveCount(0);

  // When the background turn ends: unread badge on main's row + an OS notification.
  const mainRow = page.locator(".wt-row", { hasText: "main" });
  await expect(mainRow.locator(".wt-unread")).toBeVisible({ timeout: 15_000 });
  // Cast: the spec runs outside the app's TS project, so the window global is untyped here.
  const notes = await page.evaluate(() => (window as any).__trickshotMock.notifications);
  expect(notes).toContainEqual({ title: "Agent finished", body: "trickshot" });

  // Opening the worktree clears the badge and shows the finished turn.
  await mainRow.click();
  await expect(mainRow.locator(".wt-unread")).toHaveCount(0);
  await expect(page.locator(".msg.assistant").last()).toContainText("Read 25 files");
});
