import ornamentUrl from "../assets/lecturn-glass-constellations.svg";
import "./celestial-ornaments.css";

/** Only the engraved instruments turn; the surrounding star field stays still. */
export function CelestialOrnaments() {
  return (
    <div className="lecturn-celestial-ornaments" aria-hidden="true">
      {(["astrolabe", "orrery", "compass"] as const).map((instrument) => (
        <svg
          key={instrument}
          className={`lecturn-celestial-instrument lecturn-celestial-${instrument}`}
          viewBox="0 0 512 512"
          focusable="false"
        >
          <use href={`${ornamentUrl}#${instrument}`} />
        </svg>
      ))}
    </div>
  );
}
