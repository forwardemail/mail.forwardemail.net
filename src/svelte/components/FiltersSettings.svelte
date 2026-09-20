<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import * as Select from '$lib/components/ui/select';
  import * as Dialog from '$lib/components/ui/dialog';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Pencil from '@lucide/svelte/icons/pencil';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import Info from '@lucide/svelte/icons/info';
  import {
    filterRules,
    filtersLoading,
    filtersSaving,
    filtersError,
    filtersBlocked,
    filtersWarnings,
    foreignScripts,
    managedScriptUnreadable,
    loadFilters,
    saveFilters,
    deleteAllFilters,
  } from '../../stores/filtersStore';
  import {
    CONDITION_FIELD_LABELS,
    CONDITION_OP_LABELS,
    createRule,
    describeRule,
    isRuleEmpty,
    type ConditionField,
    type ConditionOp,
    type FilterRule,
  } from '../../utils/sieve-rules';

  interface Props {
    /** Folder paths offered in the "move to" picker. */
    folders?: { path: string; label: string }[];
    /** Label keywords offered in the "apply label" picker. */
    labels?: { keyword: string; name: string }[];
    onToast?: (message: string, type?: string) => void;
  }

  const { folders = [], labels = [], onToast }: Props = $props();

  let editing = $state<FilterRule | null>(null);
  let editingIndex = $state(-1);
  let showDeleteAll = $state(false);
  let dirty = $state(false);

  const rules = $derived($filterRules);

  onMount(() => {
    loadFilters();
  });

  const fieldOptions = Object.entries(CONDITION_FIELD_LABELS) as [ConditionField, string][];
  const opOptions = Object.entries(CONDITION_OP_LABELS) as [ConditionOp, string][];

  const openNew = () => {
    editing = createRule({ name: '' });
    editingIndex = -1;
  };

  const openEdit = (rule: FilterRule, index: number) => {
    // Clone so Cancel really cancels.
    editing = JSON.parse(JSON.stringify(rule)) as FilterRule;
    editingIndex = index;
  };

  const commitEdit = () => {
    if (!editing) return;
    const next = [...rules];
    const rule = { ...editing, name: editing.name.trim() || 'Untitled rule' };
    if (editingIndex >= 0) next[editingIndex] = rule;
    else next.push(rule);
    filterRules.set(next);
    editing = null;
    editingIndex = -1;
    dirty = true;
  };

  const removeRule = (index: number) => {
    filterRules.set(rules.filter((_, i) => i !== index));
    dirty = true;
  };

  const moveRule = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    filterRules.set(next);
    dirty = true;
  };

  const toggleRule = (index: number, enabled: boolean) => {
    const next = [...rules];
    next[index] = { ...next[index], enabled };
    filterRules.set(next);
    dirty = true;
  };

  const persist = async () => {
    const ok = await saveFilters(rules);
    if (ok) {
      dirty = false;
      onToast?.('Filters saved', 'success');
    }
  };

  const confirmDeleteAll = async () => {
    showDeleteAll = false;
    const ok = await deleteAllFilters();
    if (ok) {
      dirty = false;
      onToast?.('All filters removed', 'success');
    }
  };

  // Condition editing helpers, all operating on the in-progress clone.
  const addCondition = () => {
    if (!editing) return;
    editing.conditions = [...editing.conditions, { field: 'from', op: 'contains', value: '' }];
  };

  const removeCondition = (index: number) => {
    if (!editing) return;
    editing.conditions = editing.conditions.filter((_, i) => i !== index);
  };

  const editingInvalid = $derived(!editing || isRuleEmpty(editing));
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Filters</Card.Title>
    <Card.Description>
      Rules run on the mail server as messages arrive, so they apply on every device even when this
      app is closed.
    </Card.Description>
  </Card.Header>
  <Card.Content class="space-y-4">
    {#if $filtersBlocked === 'imap'}
      <Alert.Root>
        <AlertCircle class="h-4 w-4" />
        <Alert.Description>
          Filters need IMAP enabled on this alias. Turn IMAP on in your Forward Email account
          settings, then reload this page.
        </Alert.Description>
      </Alert.Root>
    {:else if $filtersBlocked === 'catchall'}
      <Alert.Root>
        <AlertCircle class="h-4 w-4" />
        <Alert.Description>
          Filters are not available for catch-all or wildcard aliases. Use a specific alias to set
          up rules.
        </Alert.Description>
      </Alert.Root>
    {:else}
      {#if $managedScriptUnreadable}
        <Alert.Root variant="destructive">
          <AlertCircle class="h-4 w-4" />
          <Alert.Description>
            This account already has a filter script named <code>webmail-filters</code> that was written
            outside this app. It is left untouched so its rules keep working. Rename or delete it elsewhere
            to manage filters here.
          </Alert.Description>
        </Alert.Root>
      {/if}

      {#if $foreignScripts.length}
        <Alert.Root>
          <Info class="h-4 w-4" />
          <Alert.Description>
            {$foreignScripts.length === 1 ? 'Another filter script' : 'Other filter scripts'} exist on
            this account ({$foreignScripts.map((s) => s.name).join(', ')}). They are managed
            elsewhere and are not shown or changed here.
            {#if $foreignScripts.some((s) => s.is_active)}
              One of them is currently the active script, so saving here will make these filters
              active instead.
            {/if}
          </Alert.Description>
        </Alert.Root>
      {/if}

      {#if $filtersError}
        <Alert.Root variant="destructive">
          <AlertCircle class="h-4 w-4" />
          <Alert.Description>{$filtersError}</Alert.Description>
        </Alert.Root>
      {/if}

      {#each $filtersWarnings as warning}
        <Alert.Root>
          <AlertCircle class="h-4 w-4" />
          <Alert.Description>{warning}</Alert.Description>
        </Alert.Root>
      {/each}

      {#if $filtersLoading}
        <p class="text-sm text-muted-foreground">Loading filters…</p>
      {:else if !rules.length}
        <p class="text-sm text-muted-foreground">
          No filters yet. Add one to sort mail into folders, label it, or forward it automatically.
        </p>
      {:else}
        <ul class="divide-y divide-border border border-border">
          {#each rules as rule, index (rule.id)}
            <li class="flex items-start gap-3 p-3">
              <Checkbox
                checked={rule.enabled}
                onCheckedChange={(v) => toggleRule(index, Boolean(v))}
                aria-label={`Enable ${rule.name}`}
              />
              <div class="min-w-0 flex-1">
                <p
                  class="truncate text-sm font-medium {rule.enabled ? '' : 'text-muted-foreground'}"
                >
                  {rule.name || 'Untitled rule'}
                </p>
                <p class="truncate text-xs text-muted-foreground">{describeRule(rule)}</p>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-8 w-8"
                  disabled={index === 0}
                  aria-label="Move up"
                  onclick={() => moveRule(index, -1)}
                >
                  <ChevronUp class="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-8 w-8"
                  disabled={index === rules.length - 1}
                  aria-label="Move down"
                  onclick={() => moveRule(index, 1)}
                >
                  <ChevronDown class="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-8 w-8"
                  aria-label="Edit filter"
                  onclick={() => openEdit(rule, index)}
                >
                  <Pencil class="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-8 w-8"
                  aria-label="Delete filter"
                  onclick={() => removeRule(index)}
                >
                  <Trash2 class="h-4 w-4" />
                </Button>
              </div>
            </li>
          {/each}
        </ul>
        <p class="text-xs text-muted-foreground">
          Rules run top to bottom. Use "Stop processing" to keep later rules from also applying.
        </p>
      {/if}

      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" onclick={openNew} disabled={$managedScriptUnreadable}>
          <Plus class="mr-2 h-4 w-4" />
          Add filter
        </Button>
        <Button onclick={persist} disabled={!dirty || $filtersSaving || $managedScriptUnreadable}>
          {$filtersSaving ? 'Saving…' : 'Save filters'}
        </Button>
        {#if rules.length}
          <Button
            variant="ghost"
            class="text-destructive"
            onclick={() => (showDeleteAll = true)}
            disabled={$filtersSaving}
          >
            Remove all
          </Button>
        {/if}
        {#if dirty}
          <span class="text-xs text-muted-foreground">Unsaved changes</span>
        {/if}
      </div>
    {/if}
  </Card.Content>
</Card.Root>

<Dialog.Root
  open={Boolean(editing)}
  onOpenChange={(open) => {
    if (!open) editing = null;
  }}
>
  <Dialog.Content class="sm:max-w-[560px]">
    <Dialog.Header>
      <Dialog.Title>{editingIndex >= 0 ? 'Edit filter' : 'New filter'}</Dialog.Title>
    </Dialog.Header>
    {#if editing}
      <div class="max-h-[60vh] space-y-4 overflow-y-auto py-2">
        <div class="space-y-2">
          <Label for="filter-name">Name</Label>
          <Input id="filter-name" bind:value={editing.name} placeholder="Newsletters" />
        </div>

        <div class="space-y-2">
          <Label>When a message arrives that matches</Label>
          <Select.Root
            type="single"
            value={editing.match}
            onValueChange={(v) => editing && (editing.match = v as 'all' | 'any')}
          >
            <Select.Trigger class="w-full">
              {editing.match === 'any' ? 'any of these conditions' : 'all of these conditions'}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all">all of these conditions</Select.Item>
              <Select.Item value="any">any of these conditions</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>

        {#each editing.conditions as condition, index}
          <div class="flex flex-wrap items-center gap-2">
            <Select.Root
              type="single"
              value={condition.field}
              onValueChange={(v) => (condition.field = v as ConditionField)}
            >
              <Select.Trigger class="w-[150px]">
                {CONDITION_FIELD_LABELS[condition.field]}
              </Select.Trigger>
              <Select.Content>
                {#each fieldOptions as [value, label]}
                  <Select.Item {value}>{label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <Select.Root
              type="single"
              value={condition.op}
              onValueChange={(v) => (condition.op = v as ConditionOp)}
            >
              <Select.Trigger class="w-[150px]">
                {CONDITION_OP_LABELS[condition.op]}
              </Select.Trigger>
              <Select.Content>
                {#each opOptions as [value, label]}
                  <Select.Item {value}>{label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <Input class="min-w-[140px] flex-1" bind:value={condition.value} placeholder="value" />
            <Button
              variant="ghost"
              size="icon"
              class="h-9 w-9"
              aria-label="Remove condition"
              disabled={editing.conditions.length === 1}
              onclick={() => removeCondition(index)}
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          </div>
        {/each}
        <Button variant="ghost" size="sm" onclick={addCondition}>
          <Plus class="mr-2 h-4 w-4" />
          Add condition
        </Button>

        <div class="space-y-3 border-t border-border pt-4">
          <Label>Then</Label>

          <div class="space-y-2">
            <Label class="text-xs text-muted-foreground" for="filter-folder">Move to folder</Label>
            <Select.Root
              type="single"
              value={editing.actions.fileinto || ''}
              onValueChange={(v) => editing && (editing.actions.fileinto = v || undefined)}
            >
              <Select.Trigger id="filter-folder" class="w-full">
                {editing.actions.fileinto || 'Leave in Inbox'}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="">Leave in Inbox</Select.Item>
                {#each folders as folder}
                  <Select.Item value={folder.path}>{folder.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>

          {#if labels.length}
            <div class="space-y-2">
              <Label class="text-xs text-muted-foreground" for="filter-label">Apply label</Label>
              <Select.Root
                type="single"
                value={editing.actions.label || ''}
                onValueChange={(v) => editing && (editing.actions.label = v || undefined)}
              >
                <Select.Trigger id="filter-label" class="w-full">
                  {editing.actions.label || 'No label'}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="">No label</Select.Item>
                  {#each labels as label}
                    <Select.Item value={label.keyword}>{label.name}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
          {/if}

          <label class="flex items-center gap-3 text-sm">
            <Checkbox
              checked={Boolean(editing.actions.markRead)}
              onCheckedChange={(v) => editing && (editing.actions.markRead = Boolean(v))}
            />
            <span>Mark as read</span>
          </label>
          <label class="flex items-center gap-3 text-sm">
            <Checkbox
              checked={Boolean(editing.actions.star)}
              onCheckedChange={(v) => editing && (editing.actions.star = Boolean(v))}
            />
            <span>Star it</span>
          </label>

          <div class="space-y-2">
            <Label class="text-xs text-muted-foreground" for="filter-redirect">
              Forward a copy to
            </Label>
            <Input
              id="filter-redirect"
              type="email"
              placeholder="optional@example.com"
              value={editing.actions.redirect || ''}
              oninput={(e) =>
                editing &&
                (editing.actions.redirect =
                  (e.currentTarget as HTMLInputElement).value || undefined)}
            />
          </div>

          <label class="flex items-center gap-3 text-sm">
            <Checkbox
              checked={Boolean(editing.actions.delete)}
              onCheckedChange={(v) => editing && (editing.actions.delete = Boolean(v))}
            />
            <span class="text-destructive">Delete it</span>
          </label>
          {#if editing.actions.delete}
            <p class="text-xs text-muted-foreground">
              Deleted messages are dropped at delivery and never reach any folder, so they cannot be
              recovered from Trash. Every other action above is skipped.
            </p>
          {/if}

          <label class="flex items-center gap-3 text-sm">
            <Checkbox
              checked={Boolean(editing.actions.stop)}
              onCheckedChange={(v) => editing && (editing.actions.stop = Boolean(v))}
            />
            <span>Stop processing later filters</span>
          </label>
        </div>
      </div>
    {/if}
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
      <Button onclick={commitEdit} disabled={editingInvalid}>
        {editingIndex >= 0 ? 'Update filter' : 'Add filter'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={showDeleteAll}>
  <Dialog.Content class="sm:max-w-[400px]">
    <Dialog.Header>
      <Dialog.Title>Remove all filters?</Dialog.Title>
    </Dialog.Header>
    <div class="py-4">
      <p class="text-muted-foreground">
        Every rule is deleted from the server and incoming mail stops being filtered. This cannot be
        undone.
      </p>
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (showDeleteAll = false)}>Cancel</Button>
      <Button variant="destructive" onclick={confirmDeleteAll}>Remove all</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
