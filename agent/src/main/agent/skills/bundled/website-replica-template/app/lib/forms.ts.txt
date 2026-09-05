/**
 * Form handling.
 *
 * A replica must never POST to the original site's endpoint: that would send
 * real submissions to somebody else's CRM. Instead, forms are intercepted and
 * the site's own success/error state is toggled locally, so the interaction
 * looks and feels identical without any network side effect.
 */
import { $all, type Teardown } from './runtime';

export interface FormOptions {
  formSelector?: string;
  /** Sibling/parent elements the original markup uses for the result states. */
  successSelector?: string;
  errorSelector?: string;
  /** Simulated round-trip, so the pending state is actually visible. */
  latencyMs?: number;
  /** Called with the collected fields instead of submitting anywhere. */
  onSubmit?: (data: Record<string, string>, form: HTMLFormElement) => void;
}

export function createForms(options: FormOptions = {}) {
  const {
    formSelector = 'form',
    successSelector = '.w-form-done, [data-form-success], .form-success',
    errorSelector = '.w-form-fail, [data-form-error], .form-error',
    latencyMs = 600,
    onSubmit,
  } = options;

  return function initForms(root: ParentNode = document): Teardown | void {
    const forms = $all<HTMLFormElement>(formSelector, root);
    if (!forms.length) return;

    const cleanups: Array<() => void> = [];

    for (const form of forms) {
      const parent = form.parentElement;
      const success =
        parent?.querySelector<HTMLElement>(successSelector) ??
        form.querySelector<HTMLElement>(successSelector);
      const error =
        parent?.querySelector<HTMLElement>(errorSelector) ??
        form.querySelector<HTMLElement>(errorSelector);

      const handler = (e: Event) => {
        e.preventDefault();

        if (!form.checkValidity()) {
          if (error) error.style.display = 'block';
          form.reportValidity();
          return;
        }

        const data: Record<string, string> = {};
        for (const [k, v] of new FormData(form).entries()) {
          data[k] = typeof v === 'string' ? v : v.name;
        }

        const submit = form.querySelector<HTMLButtonElement | HTMLInputElement>(
          'button[type="submit"], input[type="submit"]',
        );
        const originalLabel = submit
          ? submit instanceof HTMLInputElement
            ? submit.value
            : submit.textContent
          : null;

        if (submit) {
          submit.disabled = true;
          const waiting = submit.dataset.wait ?? 'Please wait...';
          if (submit instanceof HTMLInputElement) submit.value = waiting;
          else submit.textContent = waiting;
        }

        window.setTimeout(() => {
          if (submit) {
            submit.disabled = false;
            if (originalLabel !== null) {
              if (submit instanceof HTMLInputElement) submit.value = originalLabel;
              else submit.textContent = originalLabel;
            }
          }
          // Webflow's convention: hide the form, reveal the done block.
          if (success) {
            form.style.display = 'none';
            success.style.display = 'block';
          }
          if (error) error.style.display = 'none';
          onSubmit?.(data, form);
          console.info('[replica] form intercepted locally (not submitted):', data);
        }, latencyMs);
      };

      form.addEventListener('submit', handler);
      cleanups.push(() => form.removeEventListener('submit', handler));
    }

    return () => cleanups.forEach((c) => c());
  };
}

export const initForms = createForms();
