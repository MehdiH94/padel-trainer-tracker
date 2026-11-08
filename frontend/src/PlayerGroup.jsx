import { useEffect, useState } from "react";
import { api, dayLabel, hhmm, tnd } from "./api.js";
import Icon from "./Icon.jsx";
import { confirmDialog, Modal, toast, toastError } from "./feedback.jsx";
import { Avatar, CategoryBadge, Loading } from "./ui.jsx";

// Réservation en groupe montée par un joueur (services/group_booking côté serveur): il choisit le créneau et la
// formule (à deux, en groupe ou les deux, jamais seul), invite ses partenaires (liste ou lien); le coach reçoit la
// demande dès que le nombre minimum de joueurs est réuni.

const KINDS = [["duo", "À deux", "2 joueurs"], ["groupe", "En groupe", "3 ou 4 joueurs"]];
const what = (kinds) => (kinds.length === 2 ? "à deux ou en groupe" : kinds[0] === "duo" ? "à deux" : "en groupe");
const MEMBER = { en_formation: "a rejoint", invitation: "invité", en_attente: "a rejoint", attente_joueurs: "a rejoint", acceptee: "a rejoint", confirmee: "a rejoint" };

// Depuis un créneau libre: choisir la formule puis ouvrir la page du groupe (invitations)
export function GroupStart({ o, durs, onClose }) {
  const [kinds, setKinds] = useState(["groupe"]);
  const [busy, setBusy] = useState(false);
  const flip = (k) => setKinds(kinds.includes(k) ? (kinds.length > 1 ? kinds.filter((x) => x !== k) : kinds) : KINDS.map(([x]) => x).filter((x) => x === k || kinds.includes(x)));
  const create = () => {
    setBusy(true);
    api("/me/group-bookings", { method: "POST", body: { coach_id: o.coach.id, start: o.start, kinds, durations: { duo: durs.duo, groupe: durs.groupe } } })
      .then((g) => { onClose(); location.hash = "/groupe/" + g.token; })
      .catch((x) => { toastError(x); setBusy(false); });
  };
  return (
    <Modal onClose={onClose} label="Réservation en groupe">
      <div className="row"><b className="sheet-title">Réservation en groupe</b><button className="small sec iconbtn" aria-label="Fermer" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <p className="mut small-p"><span className="cap1">{dayLabel(o.start)}</span> à {hhmm(o.start)} avec {o.coach.name}. Vous invitez vos partenaires ; la demande part au coach dès que vous êtes assez nombreux.</p>
      <div className="kindcards" role="group" aria-label="Formule du groupe">
        {KINDS.map(([k, l, d]) => (
          <button key={k} className={"kindcard" + (kinds.includes(k) ? " on" : "")} role="checkbox" aria-checked={kinds.includes(k)} onClick={() => flip(k)}>
            <span className="ki"><Icon name="users" size={22} /></span><b>{l}</b><small>{d}</small>
            <span className={"tick" + (kinds.includes(k) ? "" : " off")}>{kinds.includes(k) && <Icon name="check" size={12} strokeWidth={3} />}</span>
          </button>
        ))}
      </div>
      <p className="mut small-p"><Icon name="users" size={13} /> Minimum {kinds.includes("duo") ? "2 joueurs (vous compris)" : "3 joueurs (vous compris)"} pour envoyer la demande au coach.</p>
      <button style={{ width: "100%" }} disabled={busy} onClick={create}>{busy ? "Création…" : "Créer et inviter des joueurs"}</button>
    </Modal>
  );
}

// Page d'un groupe (#/groupe/<lien>): l'organisateur invite, les invités acceptent ou refusent
export function GroupPage({ token, me, go, reload }) {
  const [g, setG] = useState(null);
  const [error, setError] = useState(null);
  const [players, setPlayers] = useState(null);
  const [chosen, setChosen] = useState([]);
  const load = () => api(`/me/groups/${token}`).then((x) => {
    setG(x);
    if (x.is_host && !x.past) api(`/me/groups/${token}/invitable`).then(setPlayers).catch(() => setPlayers([]));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [token]);
  if (error) return <div className="card empty"><Icon name="users" size={30} /><b>Invitation introuvable</b><div className="mut">{error}</div><button onClick={() => go("home")}>Accueil</button></div>;
  if (!g) return <Loading rows={3} />;
  const link = `${location.origin}/#/groupe/${token}`;
  const text = `${g.host} t'invite à un entraînement de padel ${what(g.kinds)} avec ${g.coach_name}, ${dayLabel(g.start)} à ${hhmm(g.start)} : ${link}`;
  const missing = Math.max(g.min - g.count, 0);
  const done = (msg) => { toast(msg); load(); reload?.(); };
  const invite = () => api(`/me/groups/${token}/invite`, { method: "POST", body: { player_ids: chosen, base: location.origin } })
    .then((r) => { setChosen([]); done(`${r.sent} invitation${r.sent > 1 ? "s" : ""} envoyée${r.sent > 1 ? "s" : ""}`); }).catch(toastError);
  const copy = () => navigator.clipboard?.writeText(link).then(() => toast("Lien copié"), () => toast(link));
  const join = () => api(`/me/groups/${token}/join`, { method: "POST" }).then((x) => done(x.formed ? "C'est noté ! La demande est chez le coach." : "C'est noté, vous faites partie du groupe !")).catch(toastError);
  const decline = () => api(`/me/groups/${token}/decline`, { method: "POST" }).then(() => done("Invitation refusée")).catch(toastError);
  const cancel = async () => {
    if (!(await confirmDialog({ title: "Annuler cette réservation en groupe ?", message: "Les joueurs qui l'ont rejointe seront prévenus.", confirm: "Annuler le groupe", danger: true }))) return;
    api(`/me/groups/${token}/cancel`, { method: "POST" }).then(() => { toast("Réservation en groupe annulée"); reload?.(); go("planning"); }).catch(toastError);
  };
  const member = g.my_status && g.my_status !== "invitation" && g.my_status !== "refusee";
  return (
    <>
      <h1>Entraînement en groupe</h1>
      <div className="card group-card">
        <div className="mut small-p">Organisé par <b>{g.host}</b> · {what(g.kinds)}</div>
        <b className="sheet-title cap1">{dayLabel(g.start)} à {hhmm(g.start)}</b>
        <div className="mut"><Icon name="user" size={13} /> {g.coach_name} · {g.duration_min} min · {tnd(g.price_millimes)} par joueur au départ</div>
        <div className="partners" style={{ marginTop: 8 }}>
          {g.members.map((m, i) => (
            <span key={i} className={"partner" + (m.status === "invitation" ? " invited" : "")}><Avatar name={m.name} size={22} /> {m.name.split(" ")[0]} <CategoryBadge category={m.category} /> <small className="mut">{i === 0 ? "organise" : MEMBER[m.status] ?? ""}</small></span>
          ))}
        </div>
        <div className={"status-line " + (g.formed ? "confirmee" : "attente_joueurs")} style={{ marginTop: 8 }}>
          {g.formed ? `Demande envoyée au coach (${g.count} joueurs)` : `${g.count}/${g.min} joueurs : encore ${missing} pour envoyer la demande au coach`}
        </div>
      </div>

      {!g.is_host && !member && !g.past && g.count < g.max && (
        <div className="actions">
          <button onClick={join} disabled={!me.can_book}><Icon name="check" size={16} /> Rejoindre l'entraînement</button>
          {g.my_status === "invitation" && <button className="sec" onClick={decline}>Refuser</button>}
        </div>
      )}
      {!g.is_host && member && <div className="mut small-p"><Icon name="checkCircle" size={13} /> Vous faites partie du groupe{g.formed ? " : le coach va confirmer." : "."}</div>}

      {g.is_host && !g.past && (
        <>
          <h2>Inviter des joueurs</h2>
          <div className="card">
            <div className="actions" style={{ marginTop: 0 }}>
              <button className="sec" onClick={copy}><Icon name="copy" size={15} /> Copier le lien</button>
              <a className="btnlink wa" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={15} /> WhatsApp</a>
            </div>
            <div className="mut small-p" style={{ margin: "10px 0 6px" }}>Ou choisissez parmi les joueurs de {g.coach_name} de votre niveau :</div>
            {players === null ? <Loading rows={2} /> : players.length === 0 ? <div className="mut small-p">Aucun autre joueur compatible pour l'instant : partagez le lien.</div> : (
              <div className="invite-list">
                {players.map((p) => (
                  <label key={p.id} className="check">
                    <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => setChosen(chosen.includes(p.id) ? chosen.filter((x) => x !== p.id) : [...chosen, p.id])} />
                    <span>{p.name} <CategoryBadge category={p.category} /></span>
                  </label>
                ))}
              </div>
            )}
            {chosen.length > 0 && <button style={{ width: "100%", marginTop: 8 }} onClick={invite}><Icon name="send" size={15} /> Inviter {chosen.length} joueur{chosen.length > 1 ? "s" : ""}</button>}
          </div>
          {!g.formed && <button className="link center" onClick={cancel}>Annuler la réservation en groupe</button>}
        </>
      )}
    </>
  );
}
