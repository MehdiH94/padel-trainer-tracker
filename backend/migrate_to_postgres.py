"""Recopie une base SQLite de l'application dans une base PostgreSQL neuve (une seule fois).

    DATABASE_URL=postgresql+psycopg://app:…@db:5432/app python migrate_to_postgres.py /chemin/padel.db

Le schéma PostgreSQL est créé par l'application (create_all); les lignes sont lues avec les modèles
(booléens, dates en UTC convertis), puis les compteurs d'identifiants recalés. Refuse une base cible
qui contient déjà des données.
"""
import sys

from sqlalchemy import create_engine, func, inspect, select, text

from app.db import Base, engine as pg
from app import models  # noqa: F401  (enregistre les tables)


def main(path: str) -> None:
    if pg.dialect.name != "postgresql":
        sys.exit("DATABASE_URL doit désigner la base PostgreSQL cible")
    src = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(pg)
    tables = Base.metadata.sorted_tables  # parents avant enfants
    with pg.connect() as c:
        for t in tables:
            if c.execute(select(func.count()).select_from(t)).scalar():
                sys.exit(f"La base cible n'est pas vide (table {t.name}) : rien n'a été copié")
    src_tables = set(inspect(src).get_table_names())
    total = 0
    with src.connect() as s, pg.begin() as c:
        for t in tables:
            if t.name not in src_tables:
                continue
            present = {col["name"] for col in inspect(src).get_columns(t.name)}
            cols = [col for col in t.columns if col.name in present]
            rows = [dict(r._mapping) for r in s.execute(select(*cols))]
            if rows:
                c.execute(t.insert(), rows)
            total += len(rows)
            print(f"{t.name}: {len(rows)}")
            if "id" in t.columns and t.columns["id"].autoincrement:
                c.execute(text(f"SELECT setval(pg_get_serial_sequence('{t.name}', 'id'), COALESCE((SELECT MAX(id) FROM {t.name}), 0) + 1, false)"))
    print(f"Terminé : {total} lignes copiées")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
