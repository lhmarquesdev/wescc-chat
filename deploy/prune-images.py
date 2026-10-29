#!/usr/bin/env python3
"""Remove somente imagens próprias que não sejam atual, anterior ou usadas por containers."""
import argparse
import json
import re
import subprocess
import sys

IMAGE = re.compile(r"wescchat-hml:[a-f0-9]{40}\Z")
REVISION = re.compile(r"[a-f0-9]{40}\Z")
SOURCE = "https://github.com/lhmarquesdev/wescc-chat"


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True)


def inspect_images(*references):
    return json.loads(docker("image", "inspect", *references))


def used_images():
    containers = docker("container", "ls", "--all", "--quiet", "--no-trunc").split()
    if not containers:
        return set()
    return {item["Image"] for item in json.loads(docker("container", "inspect", *containers))}


def check_current(current_id):
    container = json.loads(docker("container", "inspect", "wescchat-hml"))[0]
    if container["Image"] != current_id or not container["State"]["Running"]:
        raise RuntimeError("A imagem ativa mudou; limpeza interrompida.")
    if container["State"].get("Health", {}).get("Status") != "healthy":
        raise RuntimeError("O Wescchat não está saudável; nenhuma limpeza autorizada.")


def candidates(images, protected):
    result = []
    for image in images:
        image_id = image["Id"]
        if image_id in protected:
            continue
        tags = image.get("RepoTags") or []
        result.extend((tag, image_id) for tag in tags if IMAGE.fullmatch(tag))
        labels = image.get("Config", {}).get("Labels") or {}
        if not tags and labels.get("org.opencontainers.image.source") == SOURCE:
            if REVISION.fullmatch(labels.get("org.opencontainers.image.revision", "")):
                result.append((image_id, image_id))
    return sorted(set(result))


def prune(current, previous, apply=False):
    if not IMAGE.fullmatch(current) or not IMAGE.fullmatch(previous):
        raise RuntimeError("Informe as tags SHA completas do Wescchat atual e anterior.")
    if current == previous:
        raise RuntimeError("A versão anterior deve ser diferente da versão atual.")
    current_info = inspect_images(current)[0]
    previous_info = inspect_images(previous)[0]
    keep = {current_info["Id"], previous_info["Id"]}
    check_current(current_info["Id"])
    ids = set(docker("image", "ls", "--quiet", "--no-trunc", "--filter", "reference=wescchat-hml:*").split())
    ids.update(docker(
        "image", "ls", "--quiet", "--no-trunc", "--filter", "dangling=true",
        "--filter", f"label=org.opencontainers.image.source={SOURCE}",
    ).split())
    images = inspect_images(*sorted(ids)) if ids else []
    plan = candidates(images, keep | used_images())
    print(f"Manter atual: {current}", flush=True)
    print(f"Manter anterior: {previous}", flush=True)
    if not plan:
        print("Nenhuma imagem antiga e sem uso do Wescchat para remover.", flush=True)
        return
    for reference, expected_id in plan:
        if not apply:
            print(f"Removeria: {reference}", flush=True)
            continue
        # Revalida a imagem ativa, as tags e os containers imediatamente antes de remover.
        check_current(current_info["Id"])
        if inspect_images(current)[0]["Id"] != current_info["Id"]:
            raise RuntimeError("A tag da versão atual mudou; limpeza interrompida.")
        if inspect_images(previous)[0]["Id"] != previous_info["Id"]:
            raise RuntimeError("A tag da versão anterior mudou; limpeza interrompida.")
        actual = inspect_images(reference)[0]
        if actual["Id"] != expected_id:
            raise RuntimeError("Uma imagem mudou durante a limpeza; operação interrompida.")
        if actual["Id"] in keep | used_images():
            print(f"Preservada porque está em uso: {reference}", flush=True)
            continue
        print(f"Removendo: {reference}", flush=True)
        # Sem --force: o Docker também impede a remoção de imagens ainda referenciadas.
        subprocess.run(["docker", "image", "rm", "--", reference], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("current")
    parser.add_argument("previous")
    parser.add_argument("--apply", action="store_true", help="Remove as imagens; sem esta opção, apenas simula.")
    args = parser.parse_args()
    try:
        prune(args.current, args.previous, args.apply)
    except (RuntimeError, subprocess.CalledProcessError, KeyError, ValueError) as error:
        print(f"Limpeza de imagens interrompida: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
