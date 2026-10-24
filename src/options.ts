import { Settings } from './config';
import { loadSettings, persistSettings, subscribeSettings } from './settings';

type ToggleKey = 'enabled' | 'bilibiliEnabled' | 'youtubeEnabled' | 'otherEnabled';
const keys: ToggleKey[] = ['enabled', 'bilibiliEnabled', 'youtubeEnabled', 'otherEnabled'];
const form = document.querySelector<HTMLFormElement>('form')!;
const status = document.querySelector<HTMLElement>('#status')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const inputs = keys.map(key => document.querySelector<HTMLInputElement>(`#${key}`)!);
let pending: Partial<Pick<Settings, ToggleKey>> | null = null;
let saving = false;
let loaded = false;

function message(text: string, error = false): void {
  status.textContent = text;
  status.parentElement!.toggleAttribute('data-error', error);
  retry.hidden = !error;
}

function render(settings: Settings): void {
  inputs.forEach((input, i) => { input.checked = settings[keys[i]]; });
}

async function load(): Promise<void> {
  inputs.forEach(input => { input.disabled = true; });
  form.setAttribute('aria-busy', 'true');
  message('正在加载设置…');
  try {
    render(await loadSettings());
    loaded = true;
    inputs.forEach(input => { input.disabled = false; });
    message('设置自动保存，对已打开的网页即时生效');
  } catch {
    message('设置加载失败，请重试。', true);
  } finally {
    form.setAttribute('aria-busy', 'false');
  }
}

async function save(): Promise<void> {
  if (!pending || saving) return;
  saving = true;
  inputs.forEach(input => { input.disabled = true; });
  form.setAttribute('aria-busy', 'true');
  message('正在保存…');
  try {
    await persistSettings(pending);
    pending = null;
    render(await loadSettings());
    message('已保存，对已打开的网页即时生效');
  } catch {
    message('设置未能确认保存，请重试。', true);
  } finally {
    saving = false;
    inputs.forEach(input => { input.disabled = false; });
    form.setAttribute('aria-busy', 'false');
  }
}

inputs.forEach((input, i) => {
  input.addEventListener('change', () => {
    pending = { ...pending, [keys[i]]: input.checked };
    void save();
  });
});
form.addEventListener('submit', event => event.preventDefault());
retry.addEventListener('click', () => { void (pending ? save() : load()); });
const unsubscribe = subscribeSettings(settings => {
  if (loaded && !saving && !pending) render(settings);
});
window.addEventListener('pagehide', unsubscribe, { once: true });
void load();
