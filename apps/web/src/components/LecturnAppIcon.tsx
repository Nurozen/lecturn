// The production icon, as GitHub shows the Lecturn app, whatever this build's channel.
import appIconUrl from "../../../../assets/prod/lecturn-black-web-apple-touch-180.png";

export function LecturnAppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
