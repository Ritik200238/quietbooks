// Labelled inputs, and the feedback that goes under a button.
//
// SPDX-License-Identifier: Apache-2.0
//
// Every control here is wired to a real `<label for>` rather than a placeholder
// standing in for one: a placeholder disappears the moment someone types, and it
// is not read as a name by a screen reader.

import { useId, type ReactNode } from 'react';

import type { ActionState } from '../state/useAction';

type FieldProps = {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string;
  readonly children: (props: { id: string; describedBy: string | undefined }) => ReactNode;
};

export const Field = ({ label, hint, error, children }: FieldProps): JSX.Element => {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(' ') || undefined;

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy })}
      {hint !== undefined && (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
};

type TextFieldProps = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: ReactNode;
  readonly error?: string;
  readonly placeholder?: string;
  readonly mono?: boolean;
  readonly disabled?: boolean;
  readonly type?: 'text' | 'date' | 'datetime-local';
  readonly inputMode?: 'text' | 'numeric' | 'decimal';
};

export const TextField = ({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  mono = false,
  disabled = false,
  type = 'text',
  inputMode,
}: TextFieldProps): JSX.Element => (
  <Field label={label} hint={hint} error={error}>
    {({ id, describedBy }) => (
      <input
        id={id}
        type={type}
        className={mono ? 'field-mono' : undefined}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    )}
  </Field>
);

type SelectFieldProps<T extends string> = {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly hint?: ReactNode;
  readonly disabled?: boolean;
};

export const SelectField = <T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
}: SelectFieldProps<T>): JSX.Element => (
  <Field label={label} hint={hint}>
    {({ id, describedBy }) => (
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )}
  </Field>
);

type TextAreaFieldProps = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: ReactNode;
  readonly error?: string;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly disabled?: boolean;
};

export const TextAreaField = ({
  label,
  value,
  onChange,
  hint,
  error,
  rows = 6,
  placeholder,
  disabled = false,
}: TextAreaFieldProps): JSX.Element => (
  <Field label={label} hint={hint} error={error}>
    {({ id, describedBy }) => (
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    )}
  </Field>
);

export const Checkbox = ({
  checked,
  onChange,
  title,
  detail,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  readonly disabled?: boolean;
}): JSX.Element => (
  <label className="checkbox">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span className="checkbox-text">
      {title}
      {detail !== undefined && <em>{detail}</em>}
    </span>
  </label>
);

/**
 * What happened to the last press of a button.
 *
 * A failure shows the contract's own sentence, unedited. The contract's
 * assertions are written for people .. "caller is not the buyer" .. and replacing
 * that with a house style would throw away the only precise thing on the screen.
 */
export const ActionFeedback = <T,>({
  state,
  success,
}: {
  readonly state: ActionState<T>;
  readonly success?: (value: T) => ReactNode;
}): JSX.Element | null => {
  if (state.status === 'working') {
    return (
      <span className="working" role="status">
        <span className="spinner" aria-hidden="true" />
        {state.note}
      </span>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="stack" role="alert">
        <span className="field-error">The contract refused this call:</span>
        <p className="contract-message">{state.error}</p>
      </div>
    );
  }
  if (state.status === 'done' && success !== undefined) {
    return <div role="status">{success(state.value)}</div>;
  }
  return null;
};
