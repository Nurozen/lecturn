import type { ReactNode } from "react";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";

/** One P13.1 section of the setup sheet. */
export function SetupSection(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border/60 px-6 py-4 first:border-t-0">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">{props.title}</h3>
        {props.description === undefined ? null : (
          <p className="text-xs text-muted-foreground">{props.description}</p>
        )}
      </div>
      {props.children}
    </section>
  );
}

/** A label on the left and its control on the right. */
export function SetupRow(props: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-foreground">{props.label}</span>
        {props.description === undefined ? null : (
          <span className="text-xs text-muted-foreground">{props.description}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{props.children}</div>
    </div>
  );
}

export function SetupNumber(props: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max?: number;
  readonly unit?: string;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  const { label, value, min, max } = props;
  return (
    <NumberField
      value={value}
      min={min}
      {...(max === undefined ? {} : { max })}
      step={1}
      size="sm"
      className="w-auto"
      disabled={props.disabled}
      onValueChange={(next) => {
        if (next === null) return;
        const clamped = Math.max(min, Math.round(next));
        props.onChange(max === undefined ? clamped : Math.min(max, clamped));
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput
          aria-label={label}
          size={String(value).length}
          className="field-sizing-content w-auto min-w-[2ch] grow-0 text-right"
        />
        {props.unit === undefined ? null : (
          <span aria-hidden="true" className="self-center pr-2 text-xs">
            {props.unit}
          </span>
        )}
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

export interface SetupChoiceOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** A short set of choices as a segmented control. */
export function SetupSegmented<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<SetupChoiceOption<T>>;
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      aria-label={props.label}
      value={[props.value]}
      disabled={props.disabled}
      onValueChange={(next) => {
        const picked = props.options.find((option) => option.value === next[0]);
        if (picked !== undefined) props.onChange(picked.value);
      }}
    >
      {props.options.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** A longer set of choices as a select. */
export function SetupSelect<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<SetupChoiceOption<T>>;
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(next) => {
        const picked = props.options.find((option) => option.value === next);
        if (picked !== undefined) props.onChange(picked.value);
      }}
    >
      <SelectTrigger aria-label={props.label} size="sm" className="w-36">
        <SelectValue>
          {props.options.find((option) => option.value === props.value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function setupOptions<T extends string>(
  values: ReadonlyArray<T>,
): ReadonlyArray<SetupChoiceOption<T>> {
  return values.map((value) => ({ value, label: capitalize(value) }));
}
