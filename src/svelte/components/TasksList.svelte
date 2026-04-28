<script lang="ts">
  import CheckCircle2 from '@lucide/svelte/icons/check-circle-2';
  import Clock from '@lucide/svelte/icons/clock';
  import Check from '@lucide/svelte/icons/check';

  type Task = Record<string, unknown>;

  interface Props {
    tasks: Task[];
    onSelect?: (task: Task) => void;
    onToggleComplete?: (task: Task) => void;
    resolveTaskColor?: (task: Task) => string;
    isCompleted?: (task: Task) => boolean;
  }

  let {
    tasks = [],
    onSelect = () => {},
    onToggleComplete = () => {},
    resolveTaskColor = () => '#1c7ed6',
    isCompleted = () => false,
  }: Props = $props();

  const formatDue = (iso: unknown): string => {
    if (!iso || typeof iso !== 'string') return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const due = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays === -1) return 'Yesterday';
    if (diffDays < 0) return `${-diffDays} days ago`;
    if (diffDays <= 7) return `In ${diffDays} days`;
    const sameYear = due.getFullYear() === today.getFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: sameYear ? undefined : 'numeric',
    });
  };

  const isOverdue = (task: Task): boolean => {
    if (isCompleted(task)) return false;
    const due = (task.end || task.start) as string | undefined;
    if (!due) return false;
    return new Date(due) < new Date();
  };

  const taskTitle = (task: Task): string =>
    (task.title as string) || (task.summary as string) || 'Untitled task';
</script>

{#if tasks.length === 0}
  <div class="flex flex-col items-center justify-center h-64 text-muted-foreground gap-2">
    <CheckCircle2 class="h-10 w-10 opacity-40" />
    <p class="text-sm">No tasks</p>
    <p class="text-xs">Tasks (VTODO) from your calendars will appear here.</p>
  </div>
{:else}
  <div class="flex flex-col gap-1">
    {#each tasks as task (task.id)}
      {@const completed = isCompleted(task)}
      {@const due = (task.end || task.start) as string | undefined}
      {@const overdue = isOverdue(task)}
      <div
        class="group flex items-start gap-3 px-3 py-2.5 rounded-md border border-border hover:bg-accent/50 cursor-pointer transition-colors"
        class:opacity-60={completed}
        role="button"
        tabindex="0"
        onclick={() => onSelect(task)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(task);
          }
        }}
      >
        <button
          type="button"
          class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border-2 transition-colors
            {completed
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground/50 bg-transparent hover:border-foreground'}"
          aria-label={completed ? 'Mark task incomplete' : 'Mark task complete'}
          aria-pressed={completed}
          onclick={(e) => {
            e.stopPropagation();
            onToggleComplete(task);
          }}
        >
          {#if completed}
            <Check class="size-3.5" strokeWidth={3} />
          {/if}
        </button>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              style="background: {resolveTaskColor(task)}"
              aria-hidden="true"
            ></span>
            <span class="text-sm font-medium truncate" class:line-through={completed}>
              {taskTitle(task)}
            </span>
          </div>
          {#if due}
            <div
              class="flex items-center gap-1 text-xs mt-0.5"
              class:text-destructive={overdue}
              class:text-muted-foreground={!overdue}
            >
              <Clock class="h-3 w-3" />
              <span>{formatDue(due)}</span>
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
