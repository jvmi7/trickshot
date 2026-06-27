<script lang="ts">
  import { activeQuestion, selectedWorktree, setPendingQuestion } from "../stores";
  import * as api from "../api";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils";

  // Per-question selected option labels. Reset whenever a new question arrives
  // (keyed on the request id) so a fresh prompt never inherits stale picks.
  let selections = $state<string[][]>([]);
  let lastId = $state<string | null>(null);
  $effect(() => {
    const q = $activeQuestion;
    if (q && q.id !== lastId) {
      lastId = q.id;
      selections = q.questions.map(() => []);
    }
  });

  function toggle(qi: number, label: string, multi: boolean) {
    const cur = selections[qi] ?? [];
    selections[qi] = multi
      ? cur.includes(label)
        ? cur.filter((l) => l !== label)
        : [...cur, label]
      : [label];
    selections = [...selections]; // reassign so the derived/markup re-reads
  }
  const isSelected = (qi: number, label: string) => (selections[qi] ?? []).includes(label);

  // Submit is enabled once every question has at least one choice.
  const canSubmit = $derived(
    !!$activeQuestion && $activeQuestion.questions.every((_, i) => (selections[i] ?? []).length > 0),
  );

  function clear(wt: string) {
    setPendingQuestion(wt, null);
  }
  function submit() {
    const q = $activeQuestion;
    const wt = $selectedWorktree;
    if (!q || !wt || !canSubmit) return;
    api.replyQuestion(wt, q.id, selections);
    clear(wt);
  }
  // Skipping (Skip button / Esc / overlay) answers with no selections — the agent
  // sees "(no answer)" and decides how to proceed, rather than hanging.
  function skip() {
    const q = $activeQuestion;
    const wt = $selectedWorktree;
    if (!q || !wt) return;
    api.replyQuestion(
      wt,
      q.id,
      q.questions.map(() => []),
    );
    clear(wt);
  }
  function onOpenChange(open: boolean) {
    if (!open && $activeQuestion) skip();
  }
</script>

<Dialog.Root open={!!$activeQuestion} {onOpenChange}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>The agent has a question</Dialog.Title>
      <Dialog.Description>Pick an answer to let the agent continue.</Dialog.Description>
    </Dialog.Header>

    {#if $activeQuestion}
      <div class="flex flex-col gap-5">
        {#each $activeQuestion.questions as q, qi (qi)}
          <div class="flex flex-col gap-2">
            <div class="flex items-baseline gap-2">
              {#if q.header}
                <span
                  class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                  >{q.header}</span
                >
              {/if}
              <span class="text-sm font-medium">{q.question}</span>
            </div>
            {#if q.multiSelect}
              <span class="text-xs text-muted-foreground">Select all that apply.</span>
            {/if}
            <div class="flex flex-col gap-1.5">
              {#each q.options as opt (opt.label)}
                <button
                  type="button"
                  class={cn(
                    "flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                    isSelected(qi, opt.label) ? "border-primary bg-accent" : "border-border",
                  )}
                  onclick={() => toggle(qi, opt.label, q.multiSelect ?? false)}
                >
                  <span class="font-medium">{opt.label}</span>
                  {#if opt.description}
                    <span class="text-xs text-muted-foreground">{opt.description}</span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <Dialog.Footer>
      <Button variant="secondary" onclick={skip}>Skip</Button>
      <Button onclick={submit} disabled={!canSubmit}>Submit</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
