// Pages publiques (sans connexion): conditions d'utilisation, FAQ, aide avec les démos en vidéo.
// Ouvertes depuis la page de connexion, l'inscription et les en-têtes de l'appli (/conditions, /faq, /aide).
import { useState } from "react";
import Icon from "./Icon.jsx";

function Layout({ title, children }) {
  const back = () => (history.length > 1 ? history.back() : (location.href = "/"));
  return (
    <div className="page-wrap">
      <div className="page">
        <div className="page-top">
          <button className="small sec" onClick={back}><Icon name="chevL" size={15} /> Retour</button>
          <a href="/" className="page-brand"><img src="/logo.svg" alt="" width="28" height="28" /> Padel Boost</a>
        </div>
        <h1>{title}</h1>
        {children}
        <nav className="page-links" aria-label="Pages d'aide">
          <a href="/aide">Aide et démos</a><a href="/faq">Questions fréquentes</a><a href="/conditions">Conditions d'utilisation</a>
        </nav>
      </div>
    </div>
  );
}

// Liens en bas de la page de connexion et des inscriptions
export function PageLinks() {
  return (
    <nav className="page-links small" aria-label="Pages d'aide">
      <a href="/aide">Aide et démos</a><a href="/faq">FAQ</a><a href="/conditions">Conditions</a>
    </nav>
  );
}

// Case à cocher des inscriptions (+ champ piège anti-robots, invisible pour une personne)
export function TermsCheck({ checked, onChange, trap, onTrap }) {
  return (
    <>
      <label className="check terms">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} required />
        <span>J'accepte les <a href="/conditions" target="_blank" rel="noreferrer">conditions d'utilisation</a> et la politique de confidentialité.</span>
      </label>
      <input className="trap" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={trap} onChange={(e) => onTrap(e.target.value)} />
    </>
  );
}

const UPDATED = "18 novembre 2026";

export function Terms() {
  return (
    <Layout title="Conditions d'utilisation">
      <p className="mut">Version du {UPDATED}. En créant un compte, vous acceptez ces conditions.</p>
      <section className="legal">
        <h2>1. Le service</h2>
        <p>Padel Boost (padel-boost.net) met en relation des coachs de padel et leurs joueurs : réservation de séances, suivi des séances, des crédits et de la progression. Padel Boost est un outil : les séances sont données par les coachs, sous leur responsabilité.</p>
        <p className="todo">Éditeur du service : [nom ou raison sociale, adresse, e-mail de contact — à compléter].</p>

        <h2>2. Votre compte</h2>
        <ul>
          <li>Un compte par personne, avec des informations exactes : nom, numéro de téléphone tunisien, adresse e-mail que vous consultez.</li>
          <li>Vous confirmez votre adresse e-mail avant de réserver. Gardez votre mot de passe pour vous.</li>
          <li>Un administrateur peut vérifier une inscription (niveau, doublons) et fermer un compte faux, en double ou utilisé de façon abusive.</li>
        </ul>

        <h2>3. Réservations et annulations</h2>
        <ul>
          <li>Une demande de réservation est validée par le coach (ou automatiquement s'il l'a choisi). Vous êtes prévenu par e-mail et dans l'application.</li>
          <li>Annulation : jusqu'à 24 h avant une séance seul, 48 h avant une séance à deux ou en groupe ; vos crédits vous sont rendus. Après ce délai, vous pouvez proposer un remplaçant.</li>
          <li>Les prix sont fixés par chaque coach (au moins 20 TND par séance). Le prix d'une séance à plusieurs dépend du nombre final de joueurs.</li>
        </ul>

        <h2>4. Paiements et crédits</h2>
        <p>Vous payez votre coach directement (espèces ou virement). Padel Boost n'encaisse aucun paiement : l'application tient seulement le compte, chez chaque coach, de ce que vous avez versé et de ce que vous devez (un seul solde par coach).</p>

        <h2>5. Bon usage</h2>
        <p>Pas de faux comptes, de messages abusifs, d'envois automatisés ni de tentative de contourner le fonctionnement du site. Les comptes concernés peuvent être fermés.</p>

        <h2>6. Disponibilité</h2>
        <p>Nous faisons de notre mieux pour que le service fonctionne en continu, sans pouvoir le garantir. Il peut évoluer ou être interrompu pour maintenance.</p>

        <h2 id="confidentialite">7. Vos données personnelles</h2>
        <ul>
          <li><b>Ce que nous enregistrons</b> : nom, téléphone, e-mail, genre, niveau, main forte, côté de jeu, objectifs, vos séances et réservations, vos paiements et crédits, et les retours et notes de vos coachs.</li>
          <li><b>Pourquoi</b> : faire fonctionner le service (réservations, rappels, suivi de progression, comptes avec vos coachs). Pas de publicité, pas de revente.</li>
          <li><b>Qui les voit</b> : vos coachs (seulement leurs propres joueurs) et les administrateurs du service. Les autres joueurs ne voient que votre prénom et votre niveau dans les séances partagées.</li>
          <li><b>Où</b> : sur un serveur hébergé chez OVH (Europe). Les e-mails passent par un service d'envoi (Brevo).</li>
          <li><b>Combien de temps</b> : tant que votre compte existe ; il peut ensuite être supprimé avec son historique.</li>
          <li><b>Vos droits</b> : accès, correction et suppression de vos données, conformément à la loi organique n° 2004-63 du 27 juillet 2004 sur la protection des données à caractère personnel. Écrivez-nous à l'adresse de contact ci-dessus.</li>
          <li><b>Stockage sur votre téléphone</b> : l'application garde votre connexion et quelques préférences d'affichage dans votre navigateur. Aucun cookie publicitaire.</li>
        </ul>

        <h2>8. Modifications et droit applicable</h2>
        <p>Ces conditions peuvent évoluer ; la version en vigueur est toujours sur cette page. Elles sont soumises au droit tunisien.</p>
      </section>
    </Layout>
  );
}

const FAQ = [
  ["Joueurs", [
    ["Comment créer mon compte ?", "Avec le lien envoyé par votre coach, ou sur padel-boost.net avec « Joueur ? Créer mon compte ». Il faut un numéro de téléphone tunisien et une adresse e-mail. Vous utilisez l'application tout de suite."],
    ["Je n'ai pas reçu l'e-mail de confirmation.", "Regardez dans les spams. Sinon, touchez « Renvoyer le lien » dans l'application (une fois par minute au plus). Tant que l'adresse n'est pas confirmée, vous pouvez tout voir mais pas réserver."],
    ["Comment réserver une séance ?", "Onglet « Réserver » : choisissez votre coach (ou plusieurs), le jour, comment vous voulez jouer (seul, à deux, en groupe) et la durée, puis l'heure. Touchez « Réserver ce créneau »."],
    ["Ma séance est-elle confirmée ?", "Votre demande part chez le coach. Dès qu'il la valide, vous êtes prévenu par e-mail et dans l'application (cloche en haut)."],
    ["Pourquoi un jour est grisé ?", "« Complet » : le coach n'a plus d'heure libre ce jour-là. « Absent » : il a déclaré une absence. Choisissez un autre jour ou un autre coach."],
    ["Pourquoi certaines heures ne me sont pas proposées ?", "Vous avez déjà quelque chose à ce moment-là : une autre séance (même chez un autre coach), une demande en cours, ou un élément de votre planning (kiné, match…). Réserver vous le rappelle."],
    ["Comment je paie ?", "Directement à votre coach. L'application affiche un seul solde par coach : en vert, vos crédits d'avance ; en rouge, ce que vous lui devez."],
    ["Je ne peux plus venir.", "Annulez depuis votre planning : jusqu'à 24 h avant une séance seul, 48 h avant à deux ou en groupe, vos crédits sont rendus. Après, envoyez le lien « remplacez-moi » à un autre joueur."],
    ["Qu'est-ce qu'un « tarif privilégié » ?", "Votre coach vous a mis dans sa liste de joueurs privilégiés : les prix affichés sont déjà vos prix."],
    ["Comment installer l'application ?", "iPhone : dans Safari, bouton Partager puis « Sur l'écran d'accueil ». Android : touchez « Installer » dans l'application. Voir la page Aide et démos."],
  ]],
  ["Coachs", [
    ["Comment ajouter un joueur ?", "Onglet Joueurs, bouton « + Joueur » : nom et niveau suffisent (téléphone facultatif). Envoyez-lui ensuite son lien pour qu'il crée son compte, ou partagez « Mon lien d'inscription », le même pour tous."],
    ["Comment créer une séance ?", "Planning, bouton « + Séance » : formule, date, heure, durée (1 h ou 1 h 30). Inscrivez vos joueurs (séance confirmée tout de suite) ou prévenez-en certains, qui répondent dans l'application."],
    ["Mes réglages sont-ils enregistrés ?", "Oui, automatiquement : une pastille en bas de l'écran le confirme, et la section modifiée affiche « Enregistré »."],
    ["Quels prix puis-je mettre ?", "Pour chaque formule et durée, au moins 20 TND par joueur. Vos prix VIP ne peuvent pas être plus chers que vos prix standards."],
    ["Comment bloquer un créneau ou des vacances ?", "Planning : « Absence » pour des jours entiers, « Autre » pour un rendez-vous ou un tournoi. Vos joueurs ne peuvent pas réserver à ces moments-là."],
    ["Où voir ce que je gagne ?", "Onglet Finance : séances effectuées moins les terrains que vous avez payés, argent reçu, impayés et crédits de vos joueurs."],
  ]],
];

export function Faq() {
  const [open, setOpen] = useState(null);
  return (
    <Layout title="Questions fréquentes">
      {FAQ.map(([group, items]) => (
        <section key={group} className="faq">
          <h2>{group}</h2>
          {items.map(([q, a]) => {
            const id = group + q;
            return (
              <div key={q} className={"faq-item" + (open === id ? " on" : "")}>
                <button className="faq-q" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
                  <span>{q}</span><Icon name={open === id ? "chevD" : "chevR"} size={16} />
                </button>
                {open === id && <p className="faq-a">{a}</p>}
              </div>
            );
          })}
        </section>
      ))}
      <p className="mut small-p">Une autre question ? Demandez à votre coach, ou consultez <a href="/aide">les démos en vidéo</a>.</p>
    </Layout>
  );
}

const DEMOS = [
  ["Joueurs", [
    ["inscription", "Créer son compte", ["Ouvrez padel-boost.net et touchez « Joueur ? Créer mon compte ».", "Nom, téléphone tunisien, genre et niveau.", "Main forte, côté de jeu et objectifs.", "E-mail et mot de passe, puis confirmez votre adresse par e-mail."]],
    ["reserver", "Réserver une séance", ["Onglet Réserver : votre coach, le club.", "Le jour et le moment.", "Seul, à deux ou en groupe, et la durée.", "Rejoignez une séance ou choisissez une heure libre, puis « Réserver ce créneau »."]],
    ["installer-iphone", "Installer l'appli sur iPhone", ["Dans Safari, bouton Partager.", "« Sur l'écran d'accueil », puis « Ajouter »."]],
    ["installer-android", "Installer l'appli sur Android", ["Touchez « Installer » dans l'application.", "Confirmez : l'icône arrive sur votre écran d'accueil."]],
  ]],
  ["Coachs", [
    ["coach-joueur", "Ajouter un joueur", ["Joueurs, « + Joueur ».", "Nom et niveau (téléphone facultatif).", "Envoyez-lui son lien pour qu'il crée son compte."]],
    ["coach-seance", "Créer une séance", ["Planning, « + Séance ».", "Formule, date, heure et durée.", "Inscrivez vos joueurs, confirmez le terrain et son prix, puis enregistrez."]],
  ]],
];

export function Help() {
  return (
    <Layout title="Aide et démos">
      <p className="mut">De courtes vidéos pour prendre l'application en main. Touchez une vidéo pour la lancer.</p>
      {DEMOS.map(([group, items]) => (
        <section key={group}>
          <h2>{group}</h2>
          <div className="demo-grid">
            {items.map(([file, title, steps]) => (
              <figure key={file} className="demo card">
                <video src={`/demos/${file}.mp4`} poster={`/demos/${file}.jpg`} controls playsInline muted preload="none" />
                <figcaption>
                  <b>{title}</b>
                  <ol>{steps.map((s) => <li key={s}>{s}</li>)}</ol>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
      <p className="mut small-p">Encore une question ? Voir les <a href="/faq">questions fréquentes</a>.</p>
    </Layout>
  );
}
