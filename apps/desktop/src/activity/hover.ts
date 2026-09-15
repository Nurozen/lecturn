interface PointerPosition {
  screenX: number;
  screenY: number;
}

/** Showing or resizing a window beneath a stationary cursor is not a hover gesture. */
export class ActivityHoverIntent {
  private position: PointerPosition | undefined;

  enter(position: PointerPosition): void {
    this.position = { screenX: position.screenX, screenY: position.screenY };
  }

  move(position: PointerPosition): boolean {
    const previous = this.position;
    this.enter(position);
    return (
      previous !== undefined &&
      (previous.screenX !== position.screenX || previous.screenY !== position.screenY)
    );
  }

  leave(): void {
    this.position = undefined;
  }
}
