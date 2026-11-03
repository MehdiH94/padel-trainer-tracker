import { useEffect, useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { toast, toastError } from "./feedback.jsx";

// Page ouverte depuis le lien reçu par e-mail: l'adresse du joueur est vérifiée (DP-002)
export default function VerifyEmail({ token }) {
  const [state, setState] = useState(null); // null = en cours, { ok } ou { error }
  useEffect(() => {
    api(`/auth/verify/${token}`, { method: "POST" }).then((r) => setState(r)).catch((x) => setState({ error: x.message }));
  }, [token]);
  return (
    <div className="login-wrap">
      <div className="login card center">
        {!state && <div className="skel" style={{ height: 140 }} />}
        {state?.ok && (
          <>
            <div className="bigcheck ok" style={{ margin: "0 auto 8px" }}><Icon name="checkCircle" size={44} strokeWidth={1.6} /></div>
            <h1>Adresse vérifiée</h1>
            {state.waiting_admin
              ? <p className="mut">Merci {state.name.split(" ")[0]} ! Dernière étape : un administrateur va confirmer votre compte. Vous recevrez un e-mail, et vous pourrez alors utiliser l'application.</p>
              : <p className="mut">Merci {state.name.split(" ")[0]} ! {state.coach ? "Votre espace coach est prêt." : `Vous recevrez vos rappels de séance sur ${state.email} et vous pouvez réserver.`}</p>}
            <button style={{ width: "100%" }} onClick={() => { location.href = "/"; }}>Ouvrir l'application</button>
          </>
        )}
        {state?.error && (
          <>
            <div className="bigcheck wait" style={{ margin: "0 auto 8px" }}><Icon name="alert" size={40} strokeWidth={1.6} /></div>
            <h1>Lien expiré</h1>
            <p className="mut">{state.error}</p>
            <button style={{ width: "100%" }} onClick={() => { location.href = "/"; }}>Ouvrir l'application</button>
          </>
        )}
      </div>
    </div>
  );
}

// Bandeau tant que l'adresse e-mail n'est pas vérifiée (DP-002): pas de réservation possible
export function VerifyBanner({ me }) {
  const [sent, setSent] = useState(false);
  if (me.can_book) return null;
  const resend = () => api("/me/verify-email/resend", { method: "POST", body: { base: location.origin } })
    .then(() => { setSent(true); toast(`Nouveau lien envoyé à ${me.email}`); }).catch(toastError);
  return (
    <div className="card verify-banner" role="status">
      <Icon name="mail" size={22} />
      <div style={{ flex: 1 }}>
        <b>Vérifiez votre adresse e-mail</b>
        <div className="small-p">Ouvrez le lien envoyé à <b>{me.email}</b> pour recevoir vos rappels et pouvoir réserver. Pensez à regarder dans les spams.</div>
        <button className="small sec" style={{ marginTop: 8 }} disabled={sent} onClick={resend}>{sent ? "Lien renvoyé" : "Renvoyer le lien"}</button>
      </div>
    </div>
  );
}
