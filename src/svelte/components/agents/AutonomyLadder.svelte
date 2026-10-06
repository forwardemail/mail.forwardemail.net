<script lang="ts">
  import Lock from '@lucide/svelte/icons/lock';
  import type { ActionClass, AutonomyLevel } from '../../../types/agents';
  import { ACTION_CLASSES, AUTONOMY_LEVELS } from '../../../types/agents';
  import { actionClassLabel, allowedLevels } from '../../../utils/agent-policy';

  /**
   * Action classes × autonomy levels (spec §5.3). Exactly one level per row.
   * Changes stay local in `levels` until the parent publishes them.
   *
   * Keyboard: Left/Right move within a row, Up/Down move between rows,
   * Enter or Space selects. Roving tabindex, so the whole grid is one Tab stop.
   */
  let {
    levels = $bindable(),
    locked = [],
    published,
    readonly = false,
  }: {
    levels: Record<ActionClass, AutonomyLevel>;
    locked?: ActionClass[];
    published?: Record<ActionClass, AutonomyLevel>;
    readonly?: boolean;
  } = $props();

  const LEVEL_LABEL: Record<AutonomyLevel, string> = {
    off: 'Off',
    draft: 'Draft',
    approve: 'Approve',
    notify: 'Notify',
    silent: 'Silent',
  };

  const LEVEL_HINT: Record<AutonomyLevel, string> = {
    off: 'Refused',
    draft: 'Saved to Drafts for you to edit',
    approve: 'Waits for your yes or no',
    notify: 'Sends, then shows in the digest',
    silent: 'Sends, audit only',
  };

  let focusRow = $state(0);
  let focusCol = $state(0);
  let grid: HTMLDivElement | undefined = $state();

  const isLocked = (cls: ActionClass) => locked.includes(cls);
  const isAllowed = (cls: ActionClass, level: AutonomyLevel) => allowedLevels(cls).includes(level);

  function select(cls: ActionClass, level: AutonomyLevel) {
    if (readonly || isLocked(cls) || !isAllowed(cls, level)) return;
    levels = { ...levels, [cls]: level };
  }

  function focusCell(row: number, col: number) {
    focusRow = Math.max(0, Math.min(ACTION_CLASSES.length - 1, row));
    focusCol = Math.max(0, Math.min(AUTONOMY_LEVELS.length - 1, col));
    const el = grid?.querySelector<HTMLButtonElement>(
      `[data-row="${focusRow}"][data-col="${focusCol}"]`,
    );
    el?.focus();
  }

  function onKeydown(event: KeyboardEvent, row: number, col: number) {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      focusCell(row + move[0], col + move[1]);
    }
  }
</script>

<div class="fe-ladder" role="grid" aria-label="Autonomy by action class" bind:this={grid}>
  <div class="fe-ladder-row fe-ladder-head" role="row">
    <span class="fe-type-label" role="columnheader">Action</span>
    {#each AUTONOMY_LEVELS as level (level)}
      <span class="fe-type-label fe-ladder-colhead" role="columnheader" title={LEVEL_HINT[level]}>
        {LEVEL_LABEL[level]}
      </span>
    {/each}
  </div>

  {#each ACTION_CLASSES as cls, row (cls)}
    {@const rowLocked = isLocked(cls)}
    {@const changed = published && published[cls] !== levels[cls]}
    <div class="fe-ladder-row" role="row" class:changed>
      <span class="fe-ladder-class" role="rowheader">
        {actionClassLabel(cls)}
        {#if rowLocked}
          <Lock class="h-3 w-3 text-fg-muted" aria-hidden="true" />
          <span class="sr-only">(locked)</span>
        {/if}
      </span>
      {#each AUTONOMY_LEVELS as level, col (level)}
        {@const selected = levels[cls] === level}
        {@const disabled = readonly || !isAllowed(cls, level) || (rowLocked && !selected)}
        <span role="gridcell">
          <button
            type="button"
            class="fe-ladder-cell"
            data-level={level}
            data-row={row}
            data-col={col}
            class:selected
            aria-pressed={selected}
            aria-disabled={disabled}
            aria-label={`${actionClassLabel(cls)}: ${LEVEL_LABEL[level]}`}
            aria-describedby={rowLocked ? 'fe-ladder-lock-note' : undefined}
            title={LEVEL_HINT[level]}
            tabindex={row === focusRow && col === focusCol ? 0 : -1}
            onfocus={() => {
              focusRow = row;
              focusCol = col;
            }}
            onclick={() => select(cls, level)}
            onkeydown={(e) => onKeydown(e, row, col)}
          >
            {#if selected}{LEVEL_LABEL[level]}{/if}
          </button>
        </span>
      {/each}
    </div>
  {/each}
</div>
<p id="fe-ladder-lock-note" class="sr-only">
  Locked rows need you to sign in again before they can change.
</p>

<style>
  .fe-ladder {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-x: auto;
  }
  .fe-ladder-row {
    display: grid;
    grid-template-columns: minmax(150px, 1.6fr) repeat(5, minmax(56px, 1fr));
    gap: 4px;
    align-items: center;
    padding: 2px 4px;
    border-radius: var(--fe-radius-sm);
  }
  .fe-ladder-row.changed {
    background: var(--surface-sunken);
  }
  .fe-ladder-head {
    color: var(--fg-muted);
  }
  .fe-ladder-colhead {
    text-align: center;
  }
  .fe-ladder-class {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--type-body-sm);
    color: var(--fg-primary);
  }
  .fe-ladder-cell {
    width: 100%;
    min-height: 44px;
    border-radius: var(--fe-radius-sm);
    border: 1px dashed var(--border-default);
    background: transparent;
    font-size: var(--type-meta);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--motion-fast);
  }
  .fe-ladder-cell:hover:not([aria-disabled='true']) {
    background: var(--action-ghost-hover-bg);
  }
  .fe-ladder-cell[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.35;
  }
  .fe-ladder-cell.selected {
    border-style: solid;
    border-color: transparent;
    opacity: 1;
  }
  .fe-ladder-cell:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 1px;
  }
  .fe-ladder-cell.selected[data-level='off'] {
    background: var(--autonomy-off-bg);
    color: var(--autonomy-off-fg);
  }
  .fe-ladder-cell.selected[data-level='draft'] {
    background: var(--autonomy-draft-bg);
    color: var(--autonomy-draft-fg);
  }
  .fe-ladder-cell.selected[data-level='approve'] {
    background: var(--autonomy-approve-bg);
    color: var(--autonomy-approve-fg);
  }
  .fe-ladder-cell.selected[data-level='notify'] {
    background: var(--autonomy-notify-bg);
    color: var(--autonomy-notify-fg);
  }
  .fe-ladder-cell.selected[data-level='silent'] {
    background: var(--autonomy-silent-bg);
    color: var(--autonomy-silent-fg);
  }
</style>
