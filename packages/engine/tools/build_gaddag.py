"""
Compile dictionnaire.txt -> GADDAG minimal (Gordon 1994).

Pour chaque mot w de longueur n, on stocke les n "rotations" :
    rev(w[:i]) + SEP + w[i:]     pour i = 1..n
Le generateur de coups part ainsi d'une case d'ancrage et etend a gauche
puis a droite en une seule passe.

Meme format binaire que le DAWG (voir build_dawg.py) ; le separateur porte
le code 27.

Le tri est delegue a `sort` en externe : garder 4 millions de rotations en
memoire vive doublerait la consommation pour rien.
"""
import shutil, subprocess, sys, tempfile, time, os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_dawg import Builder, serialize, SEP


def generate_rotations(src, dst):
    n = 0
    with open(src, encoding="ascii") as fi, open(dst, "w", encoding="ascii", newline="\n") as fo:
        out = []
        for line in fi:
            w = line.strip()
            if not w:
                continue
            for i in range(1, len(w) + 1):
                out.append(w[:i][::-1] + SEP + w[i:])
                n += 1
            if len(out) > 200_000:
                fo.write("\n".join(out) + "\n")
                out.clear()
        if out:
            fo.write("\n".join(out) + "\n")
    return n


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "dictionnaire.txt")
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "packages/engine/data/gaddag.bin")
    tmpdir = Path(tempfile.mkdtemp())
    raw, srt = tmpdir / "rot.txt", tmpdir / "rot.sorted.txt"

    t0 = time.time()
    n = generate_rotations(src, raw)
    t1 = time.time()
    print(f"rotations generees : {n:>12,}   ({t1-t0:.1f} s, {raw.stat().st_size/1e6:.0f} Mo)")

    # sous Windows, `sort` resout vers System32\sort.exe, qui n'a ni -u ni -o.
    # On cherche explicitement le sort GNU (Git for Windows, MSYS, coreutils).
    gnu_sort = None
    for cand in (shutil.which("sort"), r"C:\Program Files\Git\usr\bin\sort.exe",
                 "/usr/bin/sort"):
        if cand and "System32" not in str(cand) and Path(cand).exists():
            gnu_sort = cand
            break
    if gnu_sort is None:
        raise SystemExit("sort GNU introuvable (installe Git for Windows ou coreutils)")
    env = dict(os.environ, LC_ALL="C")
    subprocess.run([gnu_sort, "-u", "-o", str(srt), str(raw)], check=True, env=env)
    t2 = time.time()
    print(f"tri externe        : {'':>12}   ({t2-t1:.1f} s)")

    b = Builder()
    with open(srt, encoding="ascii") as f:
        for line in f:
            r = line.strip()
            if r:
                b.add(r)
    root = b.finish()
    t3 = time.time()
    print(f"minimisation       : {'':>12}   ({t3-t2:.1f} s)")

    nodes, edges = serialize(root, out)
    t4 = time.time()
    print()
    print(f"noeuds        : {nodes:>12,}")
    print(f"aretes        : {edges:>12,}")
    print(f"fichier       : {out.stat().st_size/1e6:>12.2f} Mo   ({out})")
    print(f"total         : {t4-t0:>12.1f} s")

    for p in (raw, srt):
        p.unlink(missing_ok=True)
    tmpdir.rmdir()


if __name__ == "__main__":
    main()
