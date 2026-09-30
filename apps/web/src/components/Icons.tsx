import { CLAUDE_EMBLEM } from "@lecturn/shared/providerEmblems";
import React, { type SVGProps, useId } from "react";
import { cn } from "~/lib/utils";

export type Icon = React.FC<SVGProps<SVGSVGElement>>;

export const GitHubIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1024 1024" fill="none">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
      transform="scale(64)"
      fill="currentColor"
    />
  </svg>
);

export const GitIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 256 256">
    <path
      d="M251.17 116.6 139.4 4.82a16.49 16.49 0 0 0-23.31 0l-23.21 23.2 29.44 29.45a19.57 19.57 0 0 1 24.8 24.96l28.37 28.38a19.61 19.61 0 1 1-11.75 11.06L137.28 95.4v69.64a19.62 19.62 0 1 1-16.13-.57V94.2a19.61 19.61 0 0 1-10.65-25.73L81.46 39.44 4.83 116.08a16.49 16.49 0 0 0 0 23.32L116.6 251.17a16.49 16.49 0 0 0 23.32 0l111.25-111.25a16.5 16.5 0 0 0 0-23.33"
      fill="#DE4C36"
    />
  </svg>
);

export const JujutsuIcon: Icon = (props) => {
  const groupId = `${useId().replaceAll(":", "")}-jj-a`;

  return (
    <svg {...props} viewBox="0 0 1024 1024">
      <defs>
        <g id={groupId}>
          <path
            d="M380.7 632.3s-14.3 56-50.3 55.5c-12.1-.2-29-10.9-47.1-26.8-34.2 82.7-98.5 239-108.5 268.6-8.9 26.5 13 52 38.2 56 36.4 5.7 49-18.1 49-18.1s13.6 40.7 37.6 39.7c29.9-1.2 34.6-33 34.6-33s11.4 23.8 26.8 23.2c38.4-1.4 41.7-102.9 43.8-135.6 3.8-57.5 6.3-135.4 7.8-190.1-9 6.7-16.5 10.7-21.3 9.9-16.1-2.7-10.6-49.3-10.6-49.3z"
            fill="#42acde"
          />
          <path
            d="M403.7 75.1c-89.7-.3-201.5 32.6-200.6 99.6 1.3 87.4 52.2 62.4 41.2 111.2-4.9 21.6-59.9 49.8-65.5 153.8 2.8.7 5.3 1 7.2 1.2 14.2.7 29.9-26.3 29.9-26.3s9.5 38 35 38 50.7-26.3 50.7-26.3 15 30.3 39.6 32c20 1.6 34-8 34-8s.8 15 14.6 14c13.9-1.2 37.6-27.8 37.6-27.8 16.5 30.3 31.9 21 54.7 5.1 0 0 6.2 26.6 36.8 23.7 6-.6 12.3-1 18.5-1.5l.9-11.6c2-58.8-20.4-129.8-50.4-183-21.7-38.7-52.5-83.4-49.6-107.3 3.5-28.3 46.7-28.4 46.7-28.4l-48.5-16 24-37a279.7 279.7 0 0 0-56.8-5.4Z"
            fill="#2f9fdf"
          />
          <path
            d="M215.9 414.6s-15.7 27-30 26.3c-1.8-.1-4.3-.5-7-1.2l-.3 3c-2.3 52 7.7 100.3 29.7 132 35.1 50.7 92.6 112.6 122 113 36.1.6 50.4-55.4 50.4-55.4s-5.5 46.6 10.6 49.3c16 2.6 62.4-46.7 87.9-79.5 15.8-20.5 52-82.3 58.2-138.3-6.2.4-12.4 1-18.5 1.5-30.6 3-36.8-23.7-36.8-23.7-22.8 16-38.2 25.2-54.7-5 0 0-23.7 26.5-37.6 27.6-13.8 1.1-14.6-13.8-14.6-13.8s-14 9.5-34 8c-24.5-1.8-39.6-32.1-39.6-32.1s-25.2 26.3-50.7 26.3c-25.5 0-35-38-35-38z"
            fill="#0e254f"
          />
          <path
            d="M309.5 418.5a1.5 1.5 0 0 0-.7 0c-.6.2-1.1.8-1.5 1.8a34.7 34.7 0 0 0 4 16.6c5.5 10.6 12.4 22 23.3 27.6 4 2 8.5 3.5 12.5 3.3a36 36 0 0 0 12.5-2.3c4-2 7.6-3.8 10.8-6.2 6-4.4 7.6-6.5 7.6-9.8 0-3.3-2.7-3.5-7.6-.5-5 3-14.6 6.1-18.8 6.1-11.2 0-21.2-8-33.1-26.4-4.3-6.6-7.1-9.9-9-10.2zm174 5c-1.2-.2-2.4.4-3.8 1.7-2.3 2.3-2.7 4-2.6 10.7.5 9 4.8 19.2 11.8 24.6 4.4 3.3 13.2 6 20.4 5.8 6.8-1.1 18.8-6.6 15.3-10.3-2-1.6-5 .7-9.9.7-10.6 0-15.3-3.4-19.6-9-3.8-5-5.4-8.7-7.2-16.8-1.1-4.6-2.6-7.1-4.4-7.4zm-67.5 2.2a1 1 0 0 0-.4 0c-.4.1-.7.4-1.2.9-2.4 2-2.5 5.1-.2 12.6a41.4 41.4 0 0 0 25.3 22c7.6 1.7 14.5.6 20.3-2.7 3.8-2.4 5.3-5 4.4-7.3-4.8-2.9-7.7-1-13.3-1A39.5 39.5 0 0 1 424 435c-4.8-5.9-7-9.3-8-9.4zm-199 .8c-1 .3-1.4 2.7-1 7.2.3 5.3 1.3 8.2 4 12 3 4.5 11.5 11 14.7 11.7 2.5 1 6.9 2.3 10.7 2.3 3.8 0 8-.6 11.2-1.3 3.2-.7 6.8-2 10.3-4l1.3-.7c4-2.1 8-5.1 10.9-7.9l1.4-1.2c6.3-5.4 9.9-10.7 9.9-14.6 0-2.4-5.3-.5-14 5-16 9.8-31.1 13.2-40.9 9l-2.2-1.3-8.8-7.7a32.9 32.9 0 0 1-3.6-4.8c-1.4-2.2-2.5-3.4-3.3-3.7a1 1 0 0 0-.5 0z"
            fill="#71beea"
          />
          <path
            d="M221.6 468.8c-.5 0-.8.1-1.1.4-.3.2-.5.6-.6 1.2a10 10 0 0 0 .6 5.1 55 55 0 0 0 28.3 28.9 42.4 42.4 0 0 0 16.4 2c6.1-.2 12.3-1.4 16.6-3.4a48.3 48.3 0 0 0 13.7-10.6c.9-1 1.3-2 1.3-2.3 0-.6 0-.9-.3-1-.3-.3-.7-.4-1.6-.4-1.8 0-4.9.8-9.7 2.3-6.2 1.9-12.7 3-18.5 3.1-7.8.2-10.2-.4-17-3.7-4.5-2.2-12-7.7-17.7-12.8a232 232 0 0 0-7.2-6.3 63 63 0 0 0-2.4-2 12 12 0 0 0-.7-.4h-.1zm214.8 13.6c-.2 0-.5.7-.7 1.8v4a32 32 0 0 0 2.7 9.9 38.5 38.5 0 0 0 49.1 19.3c5.2-2.3 10-6.4 13-10.5 1.4-2.1 2.5-4.3 3-6.2.5-1.9.4-3.6-.3-4.9-.4-.8-.9-1.4-1.3-1.7-.3-.3-.6-.3-1-.2-.9.2-2.3 1.4-4.3 3.8-5 6.2-12.8 9.5-22.6 9.4-6.2 0-11-1.1-16-4.4-5-3.2-10.4-8.6-18-17.3-.8-1-1.7-2-2.5-2.4l-1-.6c-.1 0-.2 0 0 0zm-33.6 4.2-.6.2-1.4.7a53.5 53.5 0 0 0-4 2.5c-8 5.5-15.6 8.3-23.9 8.4-8.3 0-17.2-2.7-28-8.2a42 42 0 0 0-7.3-3c-2-.5-3.1-.5-3.6-.2-.2.1-.3.3-.4.6 0 .3 0 .8.2 1.5.4 1.3 1.4 3.1 3.1 5.5 4 5.4 10.5 10.1 19.7 14 9.3 3.9 23.8 3.5 32.4-1a42 42 0 0 0 9.1-6.5c2.6-2.6 4.5-6.5 5.3-9.6.5-1.5.6-3 .4-3.8 0-.4-.2-.7-.4-.9-.1-.2-.3-.2-.6-.2zm-132.5 30.8c-.3 0-.4 0-.5.2l-.1.5c0 .5.4 1.7 1.2 3.1a87.3 87.3 0 0 0 13.5 16.2c17 15.6 34.6 20.7 49 14.4a33.3 33.3 0 0 0 19-23c.4-2 .1-3.1-.2-3.5-.2-.2-.5-.3-1-.3l-1.7.5a24 24 0 0 0-5.7 4.6c-7.7 8-14.6 12-23 11.4-8.3-.4-18-5.2-31.7-14.3-5.2-3.4-9.4-6-12.5-7.6a15.5 15.5 0 0 0-6.3-2.2zm109.4 0c-.2 0-.3 0-.5.2-.1 0-.3.3-.4.7a9 9 0 0 0 0 3.3c.4 2.9 1.6 6.7 3.5 10.3 11 20.5 29.4 30.5 46.8 25.7a37.3 37.3 0 0 0 15.6-10c4.4-4.6 7.4-9.9 7.4-13.8 0-1.3-.1-2.3-.4-2.7 0-.3-.2-.4-.3-.4h-.5c-.6 0-1.5.4-2.7 1.2a57 57 0 0 0-4.7 3.7c-9 7.7-16.9 11.2-25.1 10-8.2-1.3-16.7-7.1-27-17.7a159.8 159.8 0 0 0-10.6-9.8 9.8 9.8 0 0 0-.9-.6l-.2-.1zm-140.2 43.5c-1 0-1.6.2-1.8.5-.2.4-.3 1 0 2.1.8 2.2 3.1 5.6 7.1 9.6a78.2 78.2 0 0 0 27.4 17.9c9.7 3.8 16.7 4.1 23.4 1.1 5.5-2.5 8.4-6.1 8.4-10.4a4 4 0 0 0-.4-2c-.3-.4-.6-.6-1-.7-.9-.1-2.5.4-4.6 1.8-2.7 2-6.4 2.3-11.3 1.2-5-1.2-11.3-3.8-19.5-8-8-4-17.5-9-21.3-11-2.9-1.4-5-2-6.4-2.1zm160.1 2.8c-.6-.1-1.7.2-3.1 1-1.4 1-3.2 2.3-5.2 4.1a58 58 0 0 1-12.7 8.7c-5.9 2.7-8.6 3.2-18.3 3.2-12.6 0-17.2-1.6-29.9-11.2a21 21 0 0 0-6.4-3.8c-.5 0-.5 0-.7.2-.2.3-.3 1-.3 2 0 2.2 1.5 5.7 3.8 9.2 2.4 3.4 5.7 7 9.2 9.5 8.1 6 14.3 7.8 26.2 7.4a34 34 0 0 0 18.3-4.1 51 51 0 0 0 13.1-9.8c3.8-3.8 6.5-8 7-10.7.4-2 .4-3.5.2-4.5a2 2 0 0 0-.5-1 1 1 0 0 0-.7-.2zm-2 21.4c-.5 0-.6 0-.8.4-.2.4-.3 1.2-.3 2.4 0 3.2 1.7 7.3 4.4 11 2.7 4 6.3 7.4 10 9.5a35 35 0 0 0 21.3 4.8c11-.9 17.8-3.4 23.8-12.6 1.5-2.5 2-4.8 1.4-6.7-.2-.7-.4-1.1-.8-1.4-.3-.2-.6-.3-1.2-.3-1 0-2.6.7-4.7 2.1-6 4.3-12 6.1-19.9 6.2-8.8 0-16.3-3-26.2-11-3.6-2.8-6-4.3-7-4.4zM290 605.5c-.6.3-.9.5-1 1a9 9 0 0 0 .1 3.3c1.8 11 13 25 24.4 30.2 8.5 4 20 4 28.5 0 7.7-3.5 16-11.1 19-17.3a25 25 0 0 0 2.2-6.3c.1-.7.1-1.3 0-1.6 0-.4-.2-.6-.4-.7-.3-.2-1.3-.2-2.8.5-1.6.7-3.6 2-6 4-10 8.2-18.6 12.1-27 11.4-8.6-.7-16.9-6-26.4-15.9a82.6 82.6 0 0 0-7.6-7.1 10 10 0 0 0-2-1.4c-.5-.2-.8-.2-1-.1z"
            fill="#309fdf"
          />
          <path
            d="M290 125.7a61.4 61.4 0 0 0-19 2.3c-19.9 5.7-33.5 15.8-36.5 52.2-3 36.6-18 45.5-20.3 46.7 14.7 26.7 38 24.5 30.1 59-2.4 11-17.6 23.5-32.8 46.5 34-27 56.4-48 99.6-100.5 0 0 39-47.6 25.1-77a52 52 0 0 0-46.1-29.2z"
            fill="#e9f2f1"
          />
          <path
            d="M288.5 120.8c-8.1 0-16.7 1.4-25.6 5.3-22.5 9.9-25 20.3-29.1 37a96.8 96.8 0 0 0-1.4 24.6 178 178 0 0 0-16.5-31.6s-19 19.8-36.5 18.6c-22.9-1.7-34 2-44.8 9.8-25.4 18.5-21.2 43.8-21.2 43.8s17.6-1.8 40.5 1c20.3 2.7 37.4 4.3 61.3 2.6 8.5-.6 15.8-10 19.3-19 4.5-4 2.9-22 4.8-24.5 3-3.4 8-4.7 10.6-5.2 3.7-.7 4.3 1.5 4.7 2.8a31 31 0 0 0 60.5-3.2c1-4.4 9-5 15.9-4.5 7 0 .9 15.9-1.7 22.3-5.4 13.2-24.9 39-24.9 39l124.3-85s-45.8 22-61.5 20c-19.7-2.3-25.7-34.8-43.2-44-9.9-5.1-22-9.6-35.5-9.8zm1.4 9.4a48.2 48.2 0 0 1 40.6 23.5c3.7 7.1 6.2 17-.3 20.2-7.6 3.7-14.7.7-15.5-2.8a31 31 0 0 0-30.2-24.1 30 30 0 0 0-30.8 27.4c-.4 5.2-9.1 7.7-12.7 3.7-2.7-3 1.7-16.8 3.7-22 6.2-16.2 27.8-25.7 45.2-26zm5.6 27.8a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm-22 29a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm40 523.4c-2.6-1.8-15.1 23.5-20 59-6.8 49-8.3 63.2-14.2 96-6 32.7-12.6 66.3-13.4 73.7-.6 4.8-1.7 19-.6 20.1 3.2 3.3 14.7-31.7 16.8-42 2-10.3 7.7-40.7 14.2-86.9 6.4-46.1 8.5-69.6 13.1-91.5 4.7-22 6.7-26.6 4.2-28.4zm66.3-27c-4.1-1.3-10.5 24.6-13.1 37.8-5.6 28.6-6.2 64-8.4 87a1099 1099 0 0 1-12 87.4c-2.7 15-8 29.4-9.8 44.6-1 9-5.2 26-.2 27.3 5.2 1.5 15.4-36.5 20-55.7 8.1-32.9 10.7-65.6 14.2-99.3 3.3-30.7 4.6-62.8 6.5-93.6.7-18.5 5.1-34.5 2.8-35.6z"
            fill="#0e254f"
          />
        </g>
      </defs>
      <rect width="1024" height="1024" rx="270" fill="#a7bcd9" />
      <use href={`#${groupId}`} transform="matrix(-1 0 0 1 1024 0)" />
      <use href={`#${groupId}`} />
    </svg>
  );
};

export const GitLabIcon = ({
  monochrome = false,
  ...props
}: SVGProps<SVGSVGElement> & { readonly monochrome?: boolean }) => (
  <svg {...props} viewBox="0 0 32 32" fill="none">
    <path
      d="m31.46 12.78-.04-.12-4.35-11.35A1.14 1.14 0 0 0 25.94.6c-.24 0-.47.1-.66.24-.19.15-.33.36-.39.6l-2.94 9h-11.9l-2.94-9A1.14 1.14 0 0 0 6.07.58a1.15 1.15 0 0 0-1.14.72L.58 12.68l-.05.11a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48 6.67-5h.02a8.09 8.09 0 0 0 2.7-9.36Z"
      fill={monochrome ? "currentColor" : "#E24329"}
    />
    <path
      d="m31.46 12.78-.04-.12a14.75 14.75 0 0 0-5.86 2.64l-9.55 7.24 6.09 4.6 6.67-5h.02a8.09 8.09 0 0 0 2.67-9.36Z"
      fill={monochrome ? "currentColor" : "#FC6D26"}
    />
    <path
      d="m9.9 27.14 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48-6.1-4.6-6.07 4.6Z"
      fill={monochrome ? "currentColor" : "#FCA326"}
    />
    <path
      d="M6.44 15.3a14.71 14.71 0 0 0-5.86-2.63l-.05.12a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 6.1-4.6-9.56-7.24Z"
      fill={monochrome ? "currentColor" : "#FC6D26"}
    />
  </svg>
);

export const AzureDevOpsIcon: Icon = (props) => {
  const id = useId().replaceAll(":", "");
  const gradientA = `${id}-azure-a`;
  const gradientB = `${id}-azure-b`;
  const gradientC = `${id}-azure-c`;

  return (
    <svg {...props} viewBox="0 0 96 96">
      <defs>
        <linearGradient
          id={gradientA}
          x1="-1032.17"
          x2="-1059.21"
          y1="145.31"
          y2="65.43"
          gradientTransform="matrix(1 0 0 -1 1075 158)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#114a8b" />
          <stop offset="1" stopColor="#0669bc" />
        </linearGradient>
        <linearGradient
          id={gradientB}
          x1="-1023.73"
          x2="-1029.98"
          y1="108.08"
          y2="105.97"
          gradientTransform="matrix(1 0 0 -1 1075 158)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopOpacity=".3" />
          <stop offset=".07" stopOpacity=".2" />
          <stop offset=".32" stopOpacity=".1" />
          <stop offset=".62" stopOpacity=".05" />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id={gradientC}
          x1="-1027.16"
          x2="-997.48"
          y1="147.64"
          y2="68.56"
          gradientTransform="matrix(1 0 0 -1 1075 158)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#3ccbf4" />
          <stop offset="1" stopColor="#2892df" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientA})`}
        d="M33.34 6.54h26.04l-27.03 80.1a4.15 4.15 0 0 1-3.94 2.81H8.15a4.14 4.14 0 0 1-3.93-5.47L29.4 9.38a4.15 4.15 0 0 1 3.94-2.83z"
      />
      <path
        fill="#0078d4"
        d="M71.17 60.26H29.88a1.91 1.91 0 0 0-1.3 3.31l26.53 24.76a4.17 4.17 0 0 0 2.85 1.13h23.38z"
      />
      <path
        fill={`url(#${gradientB})`}
        d="M33.34 6.54a4.12 4.12 0 0 0-3.95 2.88L4.25 83.92a4.14 4.14 0 0 0 3.91 5.54h20.79a4.44 4.44 0 0 0 3.4-2.9l5.02-14.78 17.91 16.7a4.24 4.24 0 0 0 2.67.97h23.29L71.02 60.26H41.24L59.47 6.55z"
      />
      <path
        fill={`url(#${gradientC})`}
        d="M66.6 9.36a4.14 4.14 0 0 0-3.93-2.82H33.65a4.15 4.15 0 0 1 3.93 2.82l25.18 74.62a4.15 4.15 0 0 1-3.93 5.48h29.02a4.15 4.15 0 0 0 3.93-5.48z"
      />
    </svg>
  );
};

export const BitbucketIcon: Icon = (props) => {
  const id = useId().replaceAll(":", "");
  const gradientId = `${id}-bitbucket-a`;

  return (
    <svg {...props} viewBox="8.4 14.39 2481.29 2231.21">
      <path fill="none" d="M989.97,1493.09h518.05l125.04-730.04H852.22L989.97,1493.09z" />
      <path
        fill="#2684FF"
        d="M88.92,14.4C45.02,13.83,8.97,48.96,8.41,92.86c-0.06,4.61,0.28,9.22,1.02,13.77l337.48,2048.72 c8.68,51.75,53.26,89.8,105.74,90.24h1619.03c39.38,0.5,73.19-27.9,79.49-66.78l337.49-2071.78c7.03-43.34-22.41-84.17-65.75-91.2 c-4.55-0.74-9.15-1.08-13.76-1.02L88.92,14.4z M1509.99,1495.09H993.24l-139.92-731h781.89L1509.99,1495.09z"
      />
      <linearGradient
        id={gradientId}
        gradientUnits="userSpaceOnUse"
        x1="945.1094"
        y1="1524.8389"
        x2="944.4923"
        y2="1524.1893"
        gradientTransform="matrix(1996.6343 0 0 -1480.3047 -1884485.625 2258195)"
      >
        <stop offset="0.18" stopColor="#0052CC" />
        <stop offset="1" stopColor="#2684FF" />
      </linearGradient>
      <path
        fill={`url(#${gradientId})`}
        d="M2379.27,763.06h-745.5l-125.12,730.42H992.31l-609.67,723.67c19.32,16.71,43.96,26,69.5,26.21h1618.13 c39.35,0.51,73.14-27.88,79.44-66.72L2379.27,763.06z"
      />
    </svg>
  );
};

export const CursorIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 466.73 532.09"
    className={cn("fill-[#26251E] dark:fill-[#EDECEC]", className)}
  >
    <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
  </svg>
);

export const GrokIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 24 24"
    fill="none"
    className={cn("fill-[#0F0F0F] dark:fill-[#F5F5F5]", className)}
  >
    <path d="M9.26905 15.284L17.2479 9.36086C17.6391 9.07047 18.1981 9.18374 18.3845 9.63478C19.3655 12.0135 18.9272 14.8721 16.9755 16.8349C15.0238 18.7976 12.3082 19.228 9.8261 18.2477L7.1146 19.5102C11.0037 22.1834 15.7263 21.5223 18.6774 18.5525C21.0182 16.1985 21.7432 12.9897 21.0653 10.0961L21.0714 10.1023C20.0884 5.85143 21.3131 4.15233 23.8218 0.677913C23.8812 0.595532 23.9406 0.513151 24 0.428711L20.6987 3.74866V3.73836L9.267 15.2861" />
    <path d="M7.62249 16.7237C4.83113 14.0422 5.3124 9.89222 7.69417 7.49905C9.45541 5.72786 12.341 5.00497 14.86 6.06768L17.5653 4.81138C17.0779 4.45714 16.4533 4.07613 15.7365 3.80839C12.4966 2.46764 8.6178 3.13492 5.98413 5.78141C3.45081 8.32904 2.65415 12.2463 4.02219 15.5889C5.04412 18.0871 3.36889 19.8541 1.68137 21.6377C1.08337 22.2699 0.483318 22.9022 0 23.5716L7.62045 16.7257" />
  </svg>
);

export const TraeIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor">
    {/* Back rectangle: left strip + bottom strip drawn separately — empty bottom-left corner is the gap between them */}
    <rect x="1" y="4" width="3" height="14" />
    <rect x="4" y="18" width="18" height="3" />
    {/* Front frame: top bar + right bar only — left and bottom are replaced by the back strips above */}
    <rect x="4" y="4" width="18" height="3" />
    <rect x="19" y="7" width="3" height="11" />
    {/* Two diamonds, offset slightly to the right within the open area */}
    <path d="M11 10L13 12L11 14L9 12Z" />
    <path d="M16 10L18 12L16 14L14 12Z" />
  </svg>
);

export const KiroIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1200 1200" fill="none">
    <rect width="1200" height="1200" rx="260" fill="#9046FF" />
    <path
      d="M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z"
      fill="#fff"
    />
    <path
      d="M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z"
      fill="#000"
    />
    <path
      d="M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z"
      fill="#000"
    />
  </svg>
);

export const VisualStudioCode: Icon = (props) => {
  const id = useId();
  const maskId = `${id}-vscode-a`;
  const topShadowFilterId = `${id}-vscode-b`;
  const sideShadowFilterId = `${id}-vscode-c`;
  const overlayGradientId = `${id}-vscode-d`;

  return (
    <svg {...props} fill="none" viewBox="0 0 100 100">
      <mask id={maskId} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#0065A9"
          d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"
        />
        <g filter={`url(#${topShadowFilterId})`}>
          <path
            fill="#007ACC"
            d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"
          />
        </g>
        <g filter={`url(#${sideShadowFilterId})`}>
          <path
            fill="#1F9CF0"
            d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"
          />
        </g>
        <path
          fill={`url(#${overlayGradientId})`}
          fillRule="evenodd"
          d="M70.851 99.317a6.224 6.224 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.633V16.413a6.25 6.25 0 0 0-3.54-5.632L75.812.874a6.226 6.226 0 0 0-7.104 1.21L29.294 38.04 12.126 25.01a4.162 4.162 0 0 0-5.317.236l-5.507 5.009a4.168 4.168 0 0 0-.004 6.162L16.186 50 1.298 63.583a4.168 4.168 0 0 0 .004 6.162l5.507 5.009a4.162 4.162 0 0 0 5.317.236L29.294 61.96l39.414 35.958a6.218 6.218 0 0 0 2.143 1.4ZM74.954 27.3 45.048 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
          opacity=".25"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
      <defs>
        <filter
          id={topShadowFilterId}
          width="116.727"
          height="92.246"
          x="-8.394"
          y="15.829"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={sideShadowFilterId}
          width="47.917"
          height="116.151"
          x="60.417"
          y="-8.076"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={overlayGradientId}
          x1="49.939"
          x2="49.939"
          y1=".258"
          y2="99.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export const VisualStudioCodeInsiders: Icon = (props) => {
  const id = useId();
  const maskId = `${id}-vscode-insiders-a`;
  const topShadowFilterId = `${id}-vscode-insiders-b`;
  const sideShadowFilterId = `${id}-vscode-insiders-c`;
  const overlayGradientId = `${id}-vscode-insiders-d`;

  return (
    <svg {...props} fill="none" viewBox="0 0 100 100">
      <mask id={maskId} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#009a7c"
          d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"
        />
        <g filter={`url(#${topShadowFilterId})`}>
          <path
            fill="#00b294"
            d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"
          />
        </g>
        <g filter={`url(#${sideShadowFilterId})`}>
          <path
            fill="#24bfa5"
            d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"
          />
        </g>
        <path
          fill={`url(#${overlayGradientId})`}
          fillRule="evenodd"
          d="M70.851 99.317a6.224 6.224 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.633V16.413a6.25 6.25 0 0 0-3.54-5.632L75.812.874a6.226 6.226 0 0 0-7.104 1.21L29.294 38.04 12.126 25.01a4.162 4.162 0 0 0-5.317.236l-5.507 5.009a4.168 4.168 0 0 0-.004 6.162L16.186 50 1.298 63.583a4.168 4.168 0 0 0 .004 6.162l5.507 5.009a4.162 4.162 0 0 0 5.317.236L29.294 61.96l39.414 35.958a6.218 6.218 0 0 0 2.143 1.4ZM74.954 27.3 45.048 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
          opacity=".25"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
      <defs>
        <filter
          id={topShadowFilterId}
          width="116.727"
          height="92.246"
          x="-8.394"
          y="15.829"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={sideShadowFilterId}
          width="47.917"
          height="116.151"
          x="60.417"
          y="-8.076"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={overlayGradientId}
          x1="49.939"
          x2="49.939"
          y1=".258"
          y2="99.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export const VSCodium: Icon = (props) => {
  const id = useId();
  const gradientId = `${id}-vscodium-gradient`;

  return (
    <svg {...props} viewBox="0 0 100 100">
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          x2="100"
          y1="0"
          y2="100"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#62A0EA" />
          <stop offset="1" stopColor="#1A5FB4" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M48.26 2.274C45.406 4.105 44.583 7.898 46.422 10.742C56.531 26.397 58.917 38.205 57.882 48.553C53.698 68.369 44.603 72.389 36.655 72.389C28.895 72.389 30.973 59.618 36.806 55.88C40.288 53.706 44.748 52.293 48.171 52.293C51.563 52.293 54.313 49.552 54.313 46.17C54.313 42.787 51.563 40.046 48.171 40.046C44.173 40.046 40.251 40.886 36.59 42.316C37.338 38.787 37.614 34.973 36.647 30.919C35.179 24.763 30.953 18.883 23.615 13.183C22.33 12.183 20.7 11.734 19.083 11.934C17.466 12.134 15.995 12.966 14.994 14.248C12.912 16.918 13.394 20.766 16.072 22.843C22.05 27.486 24.024 30.923 24.699 33.752C25.374 36.581 24.831 39.616 23.475 43.786C21.742 49.406 19.73 54.423 18.848 59.234C18.414 61.602 18.377 64.179 18.265 66.238C13.96 62.042 12.275 56.502 12.275 48.407C12.274 45.025 9.524 42.283 6.133 42.284C2.744 42.287-0.002 45.027-0.003 48.407C-0.003 59.463 3.23 69.983 11.895 77.001C19.739 84.474 39.686 81.712 39.686 93.709C39.686 97.095 44.642 98.743 48.033 98.743C51.511 98.743 55.888 96.418 55.888 93.709C55.888 80.097 70.233 71.824 93.848 71.86C97.24 71.865 99.992 69.126 99.997 65.744C100.003 62.361 97.259 59.614 93.867 59.608C92.252 59.606 90.678 59.661 89.126 59.753C91.766 53.544 92.937 46.708 92.695 39.324C92.583 35.943 89.745 33.293 86.356 33.403C82.963 33.513 80.305 36.346 80.416 39.729C80.736 49.397 80.374 58.03 73.171 62.581C71.123 63.874 68.742 64.996 66.484 64.996C68.237 60.228 69.561 55.195 70.103 49.77C70.449 46.308 70.486 42.195 70.091 39C69.478 34.05 68.738 28.436 70.617 24.207C72.305 20.565 76.087 19.04 81.64 19.04C85.029 19.037 87.775 16.296 87.776 12.917C87.778 9.534 85.031 6.79 81.64 6.787C73.388 6.787 67.133 11.13 63.587 16.377C61.733 12.417 59.475 8.336 56.747 4.112C55.866 2.747 54.478 1.788 52.887 1.443C52.099 1.272 51.285 1.257 50.491 1.399C49.697 1.542 48.939 1.839 48.26 2.274z"
      />
    </svg>
  );
};

export const Zed: Icon = (props) => {
  const id = useId();
  const clipPathId = `${id}-zed-logo-a`;

  return (
    <svg {...props} fill="none" viewBox="0 0 96 96">
      <g clipPath={`url(#${clipPathId})`}>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M9 6a3 3 0 0 0-3 3v66H0V9a9 9 0 0 1 9-9h80.379c4.009 0 6.016 4.847 3.182 7.682L43.055 57.187H57V51h6v7.688a4.5 4.5 0 0 1-4.5 4.5H37.055L26.743 73.5H73.5V36h6v37.5a6 6 0 0 1-6 6H20.743L10.243 90H87a3 3 0 0 0 3-3V21h6v66a9 9 0 0 1-9 9H6.621c-4.009 0-6.016-4.847-3.182-7.682L52.757 39H39v6h-6v-7.5a4.5 4.5 0 0 1 4.5-4.5h21.257l10.5-10.5H22.5V60h-6V22.5a6 6 0 0 1 6-6h52.757L85.757 6H9Z"
          clipRule="evenodd"
        />
      </g>
      <defs>
        <clipPath id={clipPathId}>
          <path fill="#fff" d="M0 0h96v96H0z" />
        </clipPath>
      </defs>
    </svg>
  );
};

export const OpenAI: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 260"
    className={cn("fill-black dark:fill-white", className)}
  >
    <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
  </svg>
);

export const ClaudeAI: Icon = (props) => (
  <svg {...props} viewBox={CLAUDE_EMBLEM.viewBox} fill={CLAUDE_EMBLEM.color}>
    {CLAUDE_EMBLEM.paths.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);

export const Gemini: Icon = (props) => (
  <svg {...props} viewBox="0 0 296 298" fill="none">
    <mask
      id="gemini__a"
      width="296"
      height="298"
      x="0"
      y="0"
      maskUnits="userSpaceOnUse"
      style={{ maskType: "alpha" }}
    >
      <path
        fill="#3186FF"
        d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"
      />
    </mask>
    <g mask="url(#gemini__a)">
      <g filter="url(#gemini__b)">
        <ellipse cx="163" cy="149" fill="#3689FF" rx="196" ry="159" />
      </g>
      <g filter="url(#gemini__c)">
        <ellipse cx="33.5" cy="142.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__d)">
        <ellipse cx="19.5" cy="148.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__e)">
        <path fill="#FA4340" d="M194 10.5C172 82.5 65.5 134.333 22.5 135L144-66l50 76.5Z" />
      </g>
      <g filter="url(#gemini__f)">
        <path fill="#FA4340" d="M190.5-12.5C168.5 59.5 62 111.333 19 112L140.5-89l50 76.5Z" />
      </g>
      <g filter="url(#gemini__g)">
        <path fill="#14BB69" d="M194.5 279.5C172.5 207.5 66 155.667 23 155l121.5 201 50-76.5Z" />
      </g>
      <g filter="url(#gemini__h)">
        <path fill="#14BB69" d="M196.5 320.5C174.5 248.5 68 196.667 25 196l121.5 201 50-76.5Z" />
      </g>
    </g>
    <defs>
      <filter
        id="gemini__b"
        width="464"
        height="390"
        x="-69"
        y="-46"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="18" />
      </filter>
      <filter
        id="gemini__c"
        width="265"
        height="273"
        x="-99"
        y="6"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__d"
        width="265"
        height="273"
        x="-113"
        y="12"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__e"
        width="299.5"
        height="329"
        x="-41.5"
        y="-130"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__f"
        width="299.5"
        height="329"
        x="-45"
        y="-153"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__g"
        width="299.5"
        height="329"
        x="-41"
        y="91"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__h"
        width="299.5"
        height="329"
        x="-39"
        y="132"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
    </defs>
  </svg>
);

const ANTIGRAVITY_ICON_DATA_URL =
  "data:image/png;base64,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";

export const AntigravityIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 128 128" fill="none">
    <image href={ANTIGRAVITY_ICON_DATA_URL} width="128" height="128" />
  </svg>
);

export const OpenCodeIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#opencode__clip0_1311_94969)">
      <path
        data-opencode-hole="true"
        className="dark:hidden"
        d="M24 32H8V16H24V32Z"
        fill="#CFCECD"
      />
      <path className="dark:hidden" d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="#211E1E" />
      <path
        data-opencode-hole="true"
        className="hidden dark:block"
        d="M24 32H8V16H24V32Z"
        fill="#4B4646"
      />
      <path className="hidden dark:block" d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="#F1ECEC" />
    </g>
    <defs>
      <clipPath id="opencode__clip0_1311_94969">
        <rect width="32" height="40" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

export const CrusoeIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    viewBox="354 0 111 111"
    xmlns="http://www.w3.org/2000/svg"
    className={cn("fill-black dark:fill-white", className)}
  >
    <path d="M449.936 18.065L447.648 15.7609C447.147 15.2669 446.621 15.4281 446.472 16.102L445.047 22.5219C444.897 23.1958 445.173 24.1576 445.673 24.6516L446.945 25.9892C447.408 26.5114 447.991 26.4026 448.236 25.7531L450.343 20.1672C450.588 19.5104 450.393 18.5652 449.922 18.0501L449.944 18.0506L449.936 18.065ZM433.555 5.93505L431.133 4.80808C430.487 4.53621 430.037 4.86705 430.129 5.56178L431.321 14.3745C431.413 15.0619 432.016 15.8501 432.662 16.122L434.122 16.7065C434.761 17 435.246 16.6774 435.206 15.9768L434.77 7.75213C434.729 7.05874 434.193 6.23586 433.562 5.92796L433.555 5.93505ZM389.987 3.62917L387.346 4.66825C386.708 4.93588 386.611 5.53097 387.143 5.98205L399.521 16.5212C400.06 16.9652 401.018 17.114 401.656 16.8318L403.083 16.1911C403.736 15.9239 403.847 15.3146 403.346 14.8279L392.112 4.07065C391.611 3.58392 390.654 3.39143 390.002 3.62227L389.995 3.62208L389.987 3.62917ZM389.997 23.299L373.495 14.6349C372.872 14.3126 371.951 14.4345 371.439 14.9094L369.435 16.8687C368.945 17.3589 369.067 18.0107 369.698 18.304L387.081 26.4298C387.712 26.7232 389.77 25.2317 390.252 24.7559C390.734 24.2875 390.62 23.6286 390.004 23.2992L389.997 23.299ZM358.685 32.5349L357.629 35.029C357.369 35.6709 357.735 36.2634 358.424 36.3396L380.098 38.725C380.786 38.8011 381.584 38.3409 381.843 37.699L382.386 36.3139C382.667 35.6799 382.345 35.0666 381.658 34.9613L360.48 31.5758C359.793 31.4705 358.989 31.8869 358.693 32.5205L358.693 32.5351L358.685 32.5349ZM419.744 12.135L414.364 1.53723C414.042 0.916701 413.22 0.377885 412.516 0.337729L409.604 0.225606C408.907 0.222055 408.63 0.703134 408.989 1.30276L415.449 12.1618C415.807 12.7614 418.388 13.1856 419.07 13.2179C419.751 13.2502 420.058 12.7699 419.744 12.1496L419.744 12.135ZM353.799 52.4783L353.741 55.4794C353.738 56.1789 354.305 56.6601 354.991 56.554L377.819 53.0226C378.512 52.9167 379.095 52.2687 379.113 51.5695L379.126 49.9665C379.166 49.2753 378.629 48.7657 377.93 48.8277L355.127 51.1063C354.435 51.1758 353.831 51.8014 353.791 52.5L353.799 52.4783ZM437.44 34.5603L436.122 33.5713C435.783 33.3366 435.486 33.4819 435.46 33.8894L435.27 36.6465C435.245 37.0539 435.495 37.5706 435.834 37.8053L436.763 38.5145C437.071 38.7849 437.383 38.6618 437.452 38.2701L437.892 35.76C437.962 35.3609 437.763 34.8238 437.447 34.5605L437.44 34.5603ZM419.433 31.1625L417.824 31.7766C417.445 31.9344 417.384 32.2972 417.693 32.5675L422.225 36.6426C422.526 36.9128 423.068 36.9852 423.439 36.8054L424.449 36.387C424.834 36.244 424.917 35.8891 424.631 35.5901L420.651 31.4711C420.365 31.1867 419.818 31.0486 419.426 31.1696L419.441 31.1554L419.433 31.1625ZM410.191 39.2084C409.798 39.0889 409.661 38.7064 409.876 38.3622L410.883 36.9162C411.126 36.5946 411.644 36.4404 412.03 36.5889L419.087 39.2648C419.472 39.4133 419.594 39.8027 419.365 40.1465L418.834 41.0801C418.626 41.4318 418.137 41.6305 417.743 41.5109L410.191 39.2084ZM416.811 46.7995C416.786 47.2069 416.432 47.5475 416.027 47.5589L407.344 47.7777C406.933 47.7962 406.633 47.4677 406.666 47.0604L406.893 45.4266C406.962 45.0276 407.359 44.71 407.77 44.7279L416.24 45.0501C416.651 45.0681 416.958 45.4113 416.91 45.8182L416.811 46.8067L416.811 46.7995ZM427.815 30.4111C427.412 30.3569 427.178 30.6278 427.307 31.0174L428.541 34.8901C428.663 35.2795 429.094 35.6187 429.505 35.6367L430.617 35.753C431.02 35.8145 431.276 35.5442 431.177 35.1408L430.31 31.5619C430.21 31.1584 429.802 30.7689 429.408 30.6785L427.815 30.4038L427.815 30.4111ZM397.984 26.6331L406.801 31.3661C407.228 31.5886 407.876 31.5253 408.244 31.2215L409.248 30.4386C409.637 30.1572 409.627 29.7197 409.208 29.461L400.923 24.3337C400.518 24.0754 399.864 24.1094 399.482 24.3983L397.9 25.6689C397.525 25.9653 397.557 26.3961 397.984 26.6258L397.977 26.6257L397.984 26.6331ZM441.884 32.7664L443.09 28.2357C443.22 27.7726 443.024 27.1335 442.673 26.8037L440.958 25.3088C440.584 25.0076 440.228 25.1514 440.171 25.6236L439.555 30.607C439.491 31.0863 439.731 31.7412 440.074 32.0853L441.041 32.9923C441.377 33.3363 441.754 33.2368 441.884 32.7737L441.884 32.7664ZM449.39 35.4248L448.223 33.4705C447.962 33.0556 447.494 33.0143 447.161 33.3627L444.646 36.0521C444.314 36.4006 444.253 37.0258 444.499 37.433L445.012 38.3281C445.243 38.7495 445.753 38.8794 446.157 38.6057L449.064 36.6625C449.467 36.3961 449.607 35.8313 449.376 35.4099L449.39 35.4248ZM434.72 21.3425L432.891 20.5152C432.456 20.3071 432.142 20.5321 432.218 21.0151L432.991 26.7488C433.059 27.2243 433.463 27.7813 433.906 27.9823L435.131 28.5826C435.558 28.8051 435.886 28.6022 435.855 28.1277L435.56 22.6032C435.536 22.1289 435.154 21.5651 434.727 21.3499L434.72 21.3425ZM405.723 20.749C405.285 20.949 405.222 21.37 405.596 21.6786L412.474 27.5345C412.833 27.8426 413.506 27.9476 413.944 27.7622L415.168 27.2547C415.613 27.0841 415.698 26.6636 415.354 26.334L409.031 20.2812C408.688 19.9516 408.031 19.8106 407.586 19.9812L405.73 20.7492L405.723 20.749ZM403.655 36.2546L404.363 35.2819C404.652 34.8959 404.517 34.4624 404.058 34.312L393.87 30.928C393.412 30.7703 392.812 30.9661 392.53 31.3668L391.47 32.8697C391.202 33.2709 391.359 33.7049 391.826 33.8337L402.32 36.7592C402.787 36.8879 403.38 36.6701 403.647 36.269L403.655 36.2546ZM425.93 18.3592L424.183 18.0806C423.708 18.0099 423.45 18.3312 423.621 18.7802L425.902 25.0049C426.066 25.4537 426.59 25.8901 427.066 25.9607L428.17 26.1206C428.645 26.2131 428.924 25.907 428.79 25.4517L427.034 19.3718C426.907 18.9093 426.405 18.459 425.93 18.3665L425.93 18.3592ZM421.843 24.9796L418.033 18.5693C417.787 18.1548 417.193 17.8552 416.714 17.901L414.873 18.1228C414.394 18.1832 414.223 18.5505 414.492 18.951L418.83 25.3677C419.098 25.7682 419.708 26.0391 420.187 25.9641L421.417 25.8066C421.895 25.7607 422.082 25.3866 421.843 24.9796ZM398.789 46.761L386.932 47.9394C386.453 47.9853 386.031 48.4116 386.003 48.8991L385.899 50.9151C385.893 51.396 386.281 51.7267 386.753 51.6515L398.591 49.8167C399.07 49.7489 399.486 49.2933 399.513 48.8131L399.584 47.5322C399.633 47.0525 399.268 46.6932 398.79 46.7464L398.789 46.761ZM387.04 59.9816C387.167 60.444 387.645 60.6969 388.104 60.5485L399.569 56.7217C400.028 56.566 400.306 56.0631 400.186 55.5936L399.903 54.3473C399.813 53.8713 399.358 53.5971 398.892 53.7234L387.251 56.9991C386.785 57.1254 386.493 57.6134 386.613 58.0829L387.04 59.9743L387.04 59.9816ZM389.165 38.9825C388.682 38.9335 388.159 39.2552 388.008 39.7104L387.39 41.4288C387.253 41.8844 387.528 42.2923 388.012 42.3195L399.541 43.0564C400.024 43.0836 400.54 42.7399 400.684 42.2845L401.088 41.1581C401.261 40.7108 401.015 40.3036 400.54 40.2475L389.172 38.9827L389.165 38.9825ZM464.498 55.7568C464.502 55.0646 464.01 54.2283 463.387 53.906L458.056 51.1584C457.433 50.8361 456.933 51.1438 456.937 51.8435L456.889 53.6788C456.855 54.3775 457.294 55.2708 457.864 55.6718L463.254 59.4923C463.824 59.8933 464.321 59.6657 464.362 58.9672L464.513 55.7353L464.513 55.7572L464.498 55.7568ZM460.516 75.6363C460.782 74.9946 460.625 74.0212 460.184 73.4778L454.964 67.0746C454.523 66.5312 453.941 66.6181 453.667 67.2523L452.977 68.6554C452.681 69.2891 452.766 70.2678 453.162 70.8466L458.21 78.1854C458.606 78.7568 459.165 78.713 459.46 78.0794L460.501 75.6286L460.509 75.6288L460.516 75.6363ZM429.689 106.282C430.335 106.021 430.913 105.242 430.954 104.544L432.052 89.0929C432.099 88.4018 431.603 88.0172 430.943 88.2551L429.455 88.7266C428.789 88.9352 428.174 89.6844 428.075 90.3742L425.986 106.426C425.894 107.108 426.369 107.492 427.021 107.269L429.682 106.289L429.689 106.289L429.689 106.282ZM416.435 91.6603C416.673 91.0106 416.313 90.4474 415.638 90.4153C414.964 90.3832 412.424 90.6451 412.158 91.2795L404.72 108.861C404.446 109.502 404.791 110.058 405.488 110.098L408.296 110.222C409 110.24 409.763 109.714 410.008 109.057L416.435 91.6531L416.435 91.6603ZM386.952 105.608C387.598 105.88 388.478 105.662 388.918 105.12L402.379 88.5329C402.818 87.9977 402.653 87.323 402.007 87.0438L400.674 86.3751C400.043 86.0745 399.142 86.2551 398.681 86.7752L384.181 102.941C383.72 103.454 383.849 104.143 384.472 104.443L386.938 105.593L386.952 105.608ZM446.051 80.1941C445.863 79.526 445.317 79.3588 444.827 79.8416C444.344 80.3246 442.713 82.3519 442.849 83.0332L445.364 95.393C445.5 96.0743 446.031 96.2485 446.55 95.781L448.637 93.7655C449.134 93.2683 449.38 92.32 449.199 91.6448L446.051 80.1941ZM369.852 94.0131C370.353 94.5071 371.217 94.5733 371.779 94.1579L390.259 80.7042C390.821 80.2961 390.877 79.5542 390.383 79.0676L389.299 77.8807C388.813 77.3725 387.949 77.2772 387.359 77.6554L368.015 90.1976C367.432 90.576 367.332 91.3094 367.81 91.8247L369.874 94.0137L369.867 94.0135L369.852 94.0131ZM444.092 51.7647C444.154 51.3655 443.933 50.8277 443.617 50.579L441.603 49.0035C441.286 48.7548 440.975 48.8706 440.92 49.2773L440.706 50.4232C440.615 50.8216 440.777 51.3797 441.07 51.6643L443.075 53.5893C443.368 53.8739 443.686 53.7874 443.785 53.3892L444.099 51.7794L444.092 51.7647ZM432.991 66.2629C433.363 66.0977 433.683 65.6323 433.702 65.2247L433.882 59.5158C433.892 59.1079 433.597 58.9035 433.211 59.0465L432.181 59.406C431.782 59.5195 431.433 59.9331 431.386 60.3327L430.764 66.3727C430.724 66.7797 431.012 67.0059 431.397 66.8701L433.006 66.256L432.992 66.2557L432.991 66.2629ZM424.774 59.6944C424.989 59.3429 425.485 59.1663 425.871 59.2857L425.878 59.2859L426.904 59.6259C427.305 59.7311 427.479 60.1073 427.293 60.4668L423.85 67.1476C423.664 67.5145 423.181 67.7424 422.78 67.6664L421.058 67.2645C420.664 67.1523 420.505 66.7692 420.72 66.4249L424.781 59.6946L424.774 59.6944ZM421.254 57.0522C421.562 57.3299 421.565 57.7818 421.271 58.0656L415.192 63.9273C414.898 64.2112 414.391 64.2417 414.067 63.9855L412.796 62.9176C412.495 62.6401 412.499 62.1957 412.822 61.9344L419.423 56.3268C419.731 56.0652 420.222 56.0853 420.515 56.3698L421.254 57.0376L421.254 57.0522ZM440.74 59.9929C440.977 59.6638 441.014 59.0963 440.818 58.7341L439.053 55.4962C438.857 55.134 438.483 55.1024 438.225 55.4164L437.477 56.2423C437.183 56.5262 437.081 57.0701 437.262 57.4392L438.956 61.1344C439.122 61.5104 439.481 61.5489 439.746 61.2424L440.741 59.9783L440.74 59.9929ZM420.128 83.871C419.962 84.3185 420.224 84.6679 420.709 84.6367L422.738 84.5292C423.217 84.4833 423.727 84.0811 423.849 83.6179L426.554 74.3016C426.691 73.8388 426.399 73.5032 425.928 73.5493L424.655 73.6401C424.171 73.6566 423.647 74.0366 423.488 74.4916L420.128 83.8637L420.135 83.8639L420.128 83.871ZM448.605 50.1694C448.193 49.9036 447.851 50.0842 447.831 50.5646L447.73 51.8811C447.703 52.3614 447.965 53.0095 448.338 53.3253L452.157 56.6166C452.516 56.932 452.886 56.8032 452.957 56.3313L453.222 54.079C453.271 53.5993 452.979 52.9941 452.567 52.7356L448.62 50.1697L448.605 50.1694ZM452.393 43.2133C452.28 42.744 451.797 42.418 451.318 42.4857L447.848 42.9785C447.369 43.0462 447.071 43.4831 447.183 43.9451L447.406 44.9493C447.497 45.4181 447.963 45.8383 448.446 45.8801L452.13 46.209C452.606 46.2506 452.931 45.9019 452.848 45.426L452.401 43.1989L452.4 43.2135L452.393 43.2133ZM450.994 63.4077C451.167 62.9604 451.067 62.2946 450.769 61.9225L447.263 57.619C446.965 57.2469 446.581 57.3098 446.415 57.7573L445.912 59.0196C445.717 59.4663 445.794 60.1461 446.063 60.5466L449.35 65.3181C449.619 65.7186 450.002 65.6776 450.19 65.2379L450.987 63.4075L450.994 63.4077ZM431.735 82.4455C432.18 82.2749 432.576 81.7386 432.61 81.2658L433.229 72.5657C433.263 72.0929 432.918 71.8362 432.473 72.0068L431.221 72.4407C430.769 72.5965 430.344 73.1248 430.28 73.5895L429.113 82.5085C429.049 82.9879 429.379 83.2588 429.838 83.1177L431.735 82.4528L431.735 82.4455ZM417.839 72.9673C417.372 72.8459 416.779 73.0782 416.525 73.487L410.698 82.6274C410.438 83.0288 410.61 83.4559 411.084 83.5776L412.886 83.9888C413.361 84.0959 413.94 83.8413 414.178 83.4248L419.467 74.1392C419.705 73.7228 419.511 73.3096 419.036 73.2171L417.853 72.9677L417.839 72.9673ZM446.465 71.4523C446.754 71.0662 446.823 70.4049 446.607 69.9693L443.813 64.2851C443.604 63.8569 443.194 63.8098 442.898 64.1957L442.185 65.0517C441.882 65.4228 441.783 66.098 441.962 66.5399L444.465 72.6829C444.644 73.1248 445.054 73.1938 445.357 72.83L446.465 71.4596L446.465 71.4523ZM438.954 69.2602C438.856 68.7912 438.464 68.6353 438.082 68.9241L437.058 69.6263C436.655 69.8854 436.382 70.4905 436.45 70.9733L437.555 78.625C437.623 79.1005 438 79.2633 438.397 78.9894L439.915 77.9284C440.304 77.6397 440.548 77.0266 440.443 76.5575L438.954 69.2602ZM407.153 68.3898C407.542 68.1084 407.57 67.6062 407.212 67.2763L406.296 66.3706C405.953 66.0338 405.338 65.9668 404.934 66.2405L394.896 72.7426C394.493 73.0018 394.428 73.5029 394.756 73.8613L396.194 75.2906C396.538 75.6275 397.146 75.6724 397.528 75.3836L407.139 68.3821L407.153 68.3898ZM390.468 68.0508C390.699 68.4722 391.245 68.6467 391.677 68.432L402.535 63.1319C402.966 62.9171 403.119 62.4183 402.866 61.9963L402.234 60.8867C402.011 60.4582 401.465 60.2691 401.019 60.4616L389.918 65.238C389.48 65.4307 389.291 65.9359 389.507 66.3642L390.468 68.0508ZM412.841 72.0722C413.159 71.7161 413.068 71.2473 412.633 71.0319L411.576 70.4652C411.157 70.221 410.546 70.3072 410.206 70.6482L402.135 78.8484C401.795 79.1894 401.863 79.6795 402.268 79.9232L403.89 80.7888C404.309 81.0257 404.914 80.9175 405.246 80.5618L412.841 72.0722ZM407.654 54.9715L408.181 56.4136C408.333 56.7892 408.776 56.9683 409.154 56.8178L417.378 53.4315C417.756 53.2737 417.929 52.8409 417.785 52.4582L417.421 51.5159C417.299 51.1265 416.879 50.9115 416.493 51.0545L408.097 54.021C407.712 54.1568 407.502 54.5886 407.654 54.9642L407.654 54.9715ZM460.192 33.9128C459.93 33.272 459.196 33.0051 458.578 33.317L454.657 35.3212C454.032 35.6402 453.746 36.4272 454.023 37.0611L454.686 38.9221C454.934 39.5699 455.687 39.9611 456.36 39.7819L460.625 38.6684C461.305 38.4893 461.66 37.8135 461.435 37.159L460.207 33.9132L460.192 33.9128ZM381.282 68.1545C381.927 67.8943 382.233 67.1517 381.971 66.5108L381.351 64.9715C381.119 64.3169 380.386 63.9699 379.727 64.2006L357.631 71.9488C356.979 72.1796 356.644 72.8997 356.891 73.5474L357.949 76.3224C358.211 76.9633 358.959 77.2815 359.605 77.0068L381.274 68.147L381.282 68.1545ZM442.901 44.0524C443.293 43.9314 443.502 43.5069 443.38 43.1175L442.741 41.4684C442.597 41.0857 442.161 40.9213 441.789 41.1084L440.436 41.7656C440.064 41.9454 439.89 42.4 440.034 42.7827L440.538 44.0201C440.674 44.4027 441.109 44.618 441.501 44.497L442.901 44.0524Z" />
  </svg>
);

export const GithubCopilotIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 208"
    className={cn("fill-black dark:fill-white", className)}
  >
    <path d="M205.3 31.4c14 14.8 20 35.2 22.5 63.6 6.6 0 12.8 1.5 17 7.2l7.8 10.6c2.2 3 3.4 6.6 3.4 10.4v28.7a12 12 0 0 1-4.8 9.5C215.9 187.2 172.3 208 128 208c-49 0-98.2-28.3-123.2-46.6a12 12 0 0 1-4.8-9.5v-28.7c0-3.8 1.2-7.4 3.4-10.5l7.8-10.5c4.2-5.7 10.4-7.2 17-7.2 2.5-28.4 8.4-48.8 22.5-63.6C77.3 3.2 112.6 0 127.6 0h.4c14.7 0 50.4 2.9 77.3 31.4ZM128 78.7c-3 0-6.5.2-10.3.6a27.1 27.1 0 0 1-6 12.1 45 45 0 0 1-32 13c-6.8 0-13.9-1.5-19.7-5.2-5.5 1.9-10.8 4.5-11.2 11-.5 12.2-.6 24.5-.6 36.8 0 6.1 0 12.3-.2 18.5 0 3.6 2.2 6.9 5.5 8.4C79.9 185.9 105 192 128 192s48-6 74.5-18.1a9.4 9.4 0 0 0 5.5-8.4c.3-18.4 0-37-.8-55.3-.4-6.6-5.7-9.1-11.2-11-5.8 3.7-13 5.1-19.7 5.1a45 45 0 0 1-32-12.9 27.1 27.1 0 0 1-6-12.1c-3.4-.4-6.9-.5-10.3-.6Zm-27 44c5.8 0 10.5 4.6 10.5 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.6-10.4 10.4-10.4Zm53.4 0c5.8 0 10.4 4.6 10.4 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.7-10.4 10.4-10.4Zm-73-94.4c-11.2 1.1-20.6 4.8-25.4 10-10.4 11.3-8.2 40.1-2.2 46.2A31.2 31.2 0 0 0 75 91.7c6.8 0 19.6-1.5 30.1-12.2 4.7-4.5 7.5-15.7 7.2-27-.3-9.1-2.9-16.7-6.7-19.9-4.2-3.6-13.6-5.2-24.2-4.3Zm69 4.3c-3.8 3.2-6.4 10.8-6.7 19.9-.3 11.3 2.5 22.5 7.2 27a41.7 41.7 0 0 0 30 12.2c8.9 0 17-2.9 21.3-7.2 6-6.1 8.2-34.9-2.2-46.3-4.8-5-14.2-8.8-25.4-9.9-10.6-1-20 .7-24.2 4.3ZM128 56c-2.6 0-5.6.2-9 .5.4 1.7.5 3.7.7 5.7 0 1.5 0 3-.2 4.5 3.2-.3 6-.3 8.5-.3 2.6 0 5.3 0 8.5.3-.2-1.6-.2-3-.2-4.5.2-2 .3-4 .7-5.7-3.4-.3-6.4-.5-9-.5Z" />
  </svg>
);

export const ACPRegistryIcon: Icon = ({ className, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 576 220"
    fill="none"
    className={cn("fill-black dark:fill-white", className)}
  >
    <path d="M568.003 115.821L517.278 27.9661C507.183 10.4816 489.084 0.0227367 468.894 0.0227367C448.727 0.0227367 430.674 10.4361 420.556 27.8752L343.251 161.749H242.755C236.23 161.749 230.386 158.384 227.135 152.745C223.861 147.106 223.861 140.376 227.135 134.715L277.861 46.8603C281.112 41.2216 286.955 37.8338 293.481 37.8338C300.006 37.8338 305.827 41.1988 309.101 46.8603L312.125 52.0897C313.353 54.2042 315.604 55.5002 318.036 55.5002C320.469 55.5002 322.743 54.1815 323.948 52.067L337.385 28.5118C338.795 26.0335 338.522 22.9413 336.703 20.7586C325.699 7.57131 309.874 0 293.322 0C292.662 0 292.003 0 291.321 0.0454733C272.04 0.75031 254.76 11.1864 245.074 27.9434L200.215 105.657L155.81 29.1484C145.465 11.2092 126.594 0.0227367 106.608 0.0227367C105.949 0.0227367 105.289 0.0227367 104.607 0.06821C85.3265 0.773047 68.0467 11.2092 58.3608 27.9661L7.65806 115.821C-6.25678 139.899 -0.868187 168.82 21.05 187.759C29.8945 195.422 41.6039 199.628 54.0181 199.628H148.648C151.081 199.628 153.332 198.332 154.56 196.217L168.52 172.026C169.748 169.911 169.748 167.319 168.52 165.205C167.292 163.09 165.041 161.794 162.608 161.794H56.0417C49.5163 161.794 43.6729 158.429 40.4216 152.79C37.1475 147.152 37.1475 140.422 40.4216 134.76L91.1471 46.9057C94.3985 41.2671 100.242 37.8793 106.767 37.8793C113.293 37.8793 119.113 41.2443 122.387 46.9057L194.826 172.526C195.031 172.89 195.258 173.208 195.531 173.526C198.76 178.665 202.83 183.485 207.786 187.782C216.631 195.444 228.34 199.651 240.754 199.651H321.424L315.581 209.769C314.353 211.883 314.353 214.475 315.581 216.59C316.809 218.704 319.059 220 321.492 220H349.436C351.868 220 354.119 218.704 355.347 216.59L364.396 200.901L367.17 196.468C367.17 196.468 367.261 196.331 367.284 196.263L453.274 46.9285C456.525 41.2898 462.369 37.902 468.894 37.902C475.42 37.902 481.263 41.2671 484.514 46.9285L535.24 134.783C538.491 140.422 538.514 147.174 535.24 152.813C531.988 158.452 526.145 161.84 519.62 161.84H418.669C416.236 161.84 413.985 163.136 412.757 165.25L398.774 189.442C397.546 191.556 397.546 194.148 398.774 196.263C400.002 198.377 402.253 199.673 404.686 199.673H518.21C539.81 199.673 559.295 188.237 569.026 169.843C578.053 152.79 577.666 132.623 567.981 115.843L568.003 115.821Z" />
  </svg>
);

export const PiAgentIcon: Icon = ({ className, ...props }) => (
  <svg {...props} viewBox="0 0 800 800" className={cn("fill-none", className)}>
    <rect width="800" height="800" rx="160" fill="#000" />
    <path
      fill="#fff"
      fillRule="evenodd"
      d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
    />
    <path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
  </svg>
);
