import { useEffect, useState } from "react";

// Navigation par l'adresse (#/planning, #/players/12…): le bouton retour du téléphone revient à l'écran précédent
// et chaque écran a un lien direct.
const read = (def) => (location.hash.replace(/^#\/?/, "") || def).split("/");

export function useRoute(def) {
  const [route, setRoute] = useState(() => read(def));
  useEffect(() => {
    const onChange = () => { setRoute(read(def)); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [def]);
  return [route, (path) => { location.hash = "/" + path; }];
}
