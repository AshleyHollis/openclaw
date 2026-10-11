import { css } from "lit";

export const tooltipStyles = css`
  :host {
    display: contents;
  }

  wa-tooltip:not(:defined) {
    display: none;
  }

  wa-tooltip {
    --max-width: var(--openclaw-tooltip-max-width, min(260px, calc(100vw - 16px)));
    --wa-tooltip-arrow-size: var(--openclaw-tooltip-arrow-size, 0px);
    --wa-tooltip-background-color: var(
      --openclaw-tooltip-background-color,
      color-mix(in srgb, var(--bg-elevated) 97%, var(--text) 3%)
    );
    --wa-tooltip-border-color: var(
      --openclaw-tooltip-border-color,
      var(--overlay-border, var(--border-strong))
    );
    --wa-tooltip-border-width: 1px;
    --wa-tooltip-border-style: solid;
    --wa-tooltip-content-color: var(--text);
    --wa-tooltip-border-radius: var(--openclaw-tooltip-border-radius, var(--radius-md));
    --show-duration: var(--openclaw-tooltip-popup-show-duration, var(--wa-transition-fast));
    --hide-duration: var(--openclaw-tooltip-popup-hide-duration, var(--wa-transition-fast));
    font-family: var(--font-body);
  }

  wa-tooltip::part(body) {
    padding: var(--openclaw-tooltip-padding, 5px 7px);
    box-shadow: var(--openclaw-tooltip-shadow, var(--overlay-shadow, var(--shadow-md)));
    font-size: 11px;
    font-weight: 500;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }

  :host(.sidebar-hover-tooltip) wa-tooltip[open]::part(base__popup) {
    animation: var(--openclaw-tooltip-open-animation);
  }

  @media (hover: none) {
    wa-tooltip::part(base) {
      pointer-events: none;
    }
    wa-tooltip::part(body) {
      pointer-events: auto;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    wa-tooltip {
      --show-duration: 0ms;
      --hide-duration: 0ms;
    }

    :host(.sidebar-hover-tooltip) wa-tooltip[open]::part(base__popup) {
      animation: none;
    }
  }

  @keyframes openclaw-tooltip-hover-card-in {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .tooltip-content {
    display: block;
    text-align: center;
    white-space: pre-line;
  }

  .tooltip-rich-content {
    display: block;
    pointer-events: auto;
    text-align: left;
  }
`;
