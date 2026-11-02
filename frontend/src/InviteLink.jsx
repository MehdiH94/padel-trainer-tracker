import { useState } from "react";
import { api } from "./api.js";
import Icon from "./Icon.jsx";
import { toast } from "./feedback.jsx";
import { ContactLinks } from "./ui.jsx";

// Lien d'inscription pré-rempli: à copier ou à envoyer directement (SMS, WhatsApp, e-mail)
export default function InviteLink({ player, path }) {
  const [copied, setCopied] = useState(false);
  const url = location.origin + path;
  const msg = `Bonjour ${player.name.split(" ")[0]}, voici votre lien pour créer votre compte Padel Coach (fiche déjà pré-remplie, il suffit de la compléter) : ${url}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      document.getElementById(`link-${player.id}`)?.select(); // navigateur sans presse-papiers: lien sélectionné
      document.execCommand?.("copy");
    }
    setCopied(true);
    toast("Lien copié");
  };
  return (
    <>
      <div className="linkbox">
        <input id={`link-${player.id}`} readOnly value={url} aria-label="Lien d'inscription" onFocus={(e) => e.target.select()} />
        <button type="button" className="small" onClick={copy}><Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copié" : "Copier"}</button>
      </div>
      <ContactLinks phone={player.phone} email={player.email} message={msg} subject="Votre compte Padel Coach"
        onSent={(ch) => api("/reminders/log", { method: "POST", body: { player_id: player.id, kind: "invitation", channel: ch } })} />
    </>
  );
}
