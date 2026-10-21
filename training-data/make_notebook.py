#!/usr/bin/env python3
"""Generate bulletproof rara_finetune.ipynb v2 — semua bug fixed."""
import json

cells = []
def md(s): cells.append({"cell_type":"markdown","metadata":{},"source":s})
def code(s): cells.append({"cell_type":"code","metadata":{},"source":s,"outputs":[],"execution_count":None})

md("# Rara AI Fine-Tuning\n\nImport ke Colab → Run All. Semua bug sudah diperbaiki.\n\nRuntime: **T4 GPU** | ~15 menit | 272 examples")

# ── 1: Cek GPU ──
code("""# 1. Cek GPU
import torch
assert torch.cuda.is_available(), "GPU gak ada! Runtime → Change runtime type → T4 GPU"
print(f"GPU: {torch.cuda.get_device_name(0)}")
print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")
print("OK!")""")

# ── 2: Install ──
code("""# 2. Install
!pip install -q unsloth
!pip install -q datasets huggingface_hub
print("Install OK!")""")

# ── 3: Download dataset ──
code("""# 3. Download dataset dari GitHub
import urllib.request, json
url = "https://raw.githubusercontent.com/Yz776/rara-agent/main/training-data/rara_training_v2.jsonl"
urllib.request.urlretrieve(url, "/content/rara_training_v2.jsonl")

with open("/content/rara_training_v2.jsonl") as f:
    lines = f.readlines()
print(f"Dataset: {len(lines)} examples")

for i, line in enumerate(lines[:3]):
    d = json.loads(line)
    assert "messages" in d, f"Line {i}: no messages"
print("Format OK!")""")

# ── 4: Load model ──
code("""# 4. Load Qwen2.5-7B QLoRA
from unsloth import FastLanguageModel

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name = "Qwen/Qwen2.5-7B-Instruct",
    max_seq_length = 4096,
    load_in_4bit = True,
    dtype = None,
)
model = FastLanguageModel.get_peft_model(
    model,
    r = 64,
    target_modules = ["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
    lora_alpha = 128,
    lora_dropout = 0.05,
    bias = "none",
    use_gradient_checkpointing = "unsloth",
    random_state = 42,
)
n_t = sum(p.numel() for p in model.parameters() if p.requires_grad)
n_a = sum(p.numel() for p in model.parameters())
print(f"Loaded! Trainable: {n_t:,} / {n_a:,} ({100*n_t/n_a:.1f}%)")""")

# ── 5: Format dataset ──
code("""# 5. Format dataset
from datasets import load_dataset

ds = load_dataset("json", data_files="/content/rara_training_v2.jsonl", split="train")
SYS = 'Kamu Rara. Pakai Aku bukan Saya, kamu bukan Anda. Jawab singkat + ceria + emoji. Bahasa Indonesia santai.'

def fmt(x):
    msgs = [dict(m) for m in x["messages"]]  # copy biar gak modify original
    if msgs and msgs[0]["role"] == "system":
        msgs[0]["content"] = SYS
    text = tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
    return {"text": text}

ds = ds.map(fmt)
print(f"Formatted: {len(ds)} examples")""")

# ── 6: Train ──
code("""# 6. Train! (~10-15 menit)
from unsloth import UnslothTrainer, UnslothTrainingArguments

trainer = UnslothTrainer(
    model = model,
    tokenizer = tokenizer,
    train_dataset = ds,
    dataset_text_field = "text",
    max_seq_length = 4096,
    args = UnslothTrainingArguments(
        per_device_train_batch_size = 2,
        gradient_accumulation_steps = 4,
        max_steps = 200,
        learning_rate = 1e-4,
        warmup_steps = 15,
        logging_steps = 5,
        save_steps = 50,
        output_dir = "/content/rara-ckpt",
        report_to = "none",
        weight_decay = 0.01,
        max_grad_norm = 1.0,
        seed = 42,
        lr_scheduler_type = "cosine",
        save_total_limit = 1,
    ),
)
print("Training...")
stats = trainer.train()
print(f"Done! Steps={stats.global_step} Loss={stats.training_loss:.4f}")""")

# ── 7: Test ──
code("""# 7. Test model
import torch
FastLanguageModel.for_inference(model)

for q in ["Halo siapa kamu?", "apa kabar?", "jam berapa?", "cuaca Bandung?", "15*12?", "Jelaskan blockchain", "lagi sedih", "gw bosen"]:
    msg = [{"role":"system","content":SYS},{"role":"user","content":q}]
    inp = tokenizer.apply_chat_template(msg, tokenize=True, add_generation_prompt=True, return_tensors="pt").to("cuda")
    with torch.no_grad():
        out = model.generate(input_ids=inp, max_new_tokens=200, temperature=0.7, do_sample=True, pad_token_id=tokenizer.eos_token_id)
    r = tokenizer.decode(out[0][inp.shape[1]:], skip_special_tokens=True)
    print(f"Q: {q}")
    print(f"A: {r}")
    print()""")

# ── 8: Save ──
code("""# 8. Save merged 16-bit
model.save_pretrained_merged("/content/rara-model", tokenizer, save_method="merged_16bit")
print("Model saved!")

import os
size = sum(os.path.getsize(os.path.join(d,f)) for d,_,fs in os.walk("/content/rara-model") for f in fs)
print(f"Size: {size/1e9:.2f} GB")""")

# ── 9: Build llama.cpp ──
code("""# 9. Clone + build llama.cpp
import os, subprocess
if not os.path.exists("/content/llama.cpp"):
    subprocess.run(["git", "clone", "--depth", "1", "https://github.com/ggerganov/llama.cpp", "/content/llama.cpp"], check=True)
subprocess.run(["make", "-j4"], cwd="/content/llama.cpp", capture_output=True)
print("llama.cpp built!")""")

# ── 10: Convert + quantize ──
code("""# 10. Convert GGUF + quantize Q4_K_M
import subprocess
subprocess.run(["python", "convert_hf_to_gguf.py", "/content/rara-model", "--outtype", "f16", "--outfile", "/content/rara-f16.gguf"], cwd="/content/llama.cpp", check=True)
print("F16 done!")

subprocess.run(["./llama-quantize", "/content/rara-f16.gguf", "/content/rara-q4.gguf", "Q4_K_M"], cwd="/content/llama.cpp", check=True)
print("Q4_K_M done!")

import os
print(f"Size: {os.path.getsize('/content/rara-q4.gguf')/1e9:.2f} GB")""")

# ── 11: HF token ──
code('''# 11. Set HuggingFace token (GANTI INI!)
HF_TOKEN = "PASTE_HF_TOKEN_HERE"  # ← ganti dengan token Write dari huggingface.co/settings/tokens

from huggingface_hub import HfApi
api = HfApi(token=HF_TOKEN)
try:
    info = api.whoami()
    username = info["name"]
    print(f"Logged in: {username}")
except Exception as e:
    print(f"ERROR: {e}")
    print("Buat token Write di https://huggingface.co/settings/tokens")''')

# ── 12: Upload ──
code("""# 12. Upload ke HuggingFace
REPO = f"{username}/rara-ai"
print(f"Uploading to: {REPO}")

from huggingface_hub import create_repo, upload_file
try:
    create_repo(REPO, token=HF_TOKEN, exist_ok=True, private=False)
    print("Repo ready")
except Exception as e:
    print(f"Create repo: {e}")

try:
    upload_file(
        path_or_fileobj="/content/rara-q4.gguf",
        path_in_repo="rara-q4.gguf",
        repo_id=REPO,
        token=HF_TOKEN,
    )
    print(f"SUCCESS! -> huggingface.co/{REPO}")
except Exception as e:
    print(f"Upload: {e}")""")

# ── 13: Deploy ──
code('''# 13. Deploy commands
print(f"DEPLOY KE SERVER:\\n\\ndocker exec kali ollama pull hf.co/{username}/rara-ai:rara-q4.gguf\\necho MODEL=hf.co/{username}/rara-ai:rara-q4.gguf >> /opt/rara-agent/.env\\ndocker exec kali pm2 restart rara-web\\n")''')

# ── 14: Cleanup ──
code("""# 14. Cleanup
import os, shutil
for p in ["/content/rara-f16.gguf", "/content/rara-ckpt"]:
    if os.path.exists(p):
        if os.path.isdir(p): shutil.rmtree(p)
        else: os.remove(p)
        print(f"Deleted: {p}")
print("Done!")""")

# Build notebook
nb = {
    "nbformat": 4, "nbformat_minor": 0,
    "metadata": {
        "colab": {"provenance": [], "gpuType": "T4", "toc_visible": True},
        "kernelspec": {"name": "python3", "display_name": "Python 3"},
        "language_info": {"name": "python"},
        "accelerator": "GPU",
    },
    "cells": cells,
}
out = "/home/z/my-project/training-data/rara_finetune.ipynb"
with open(out, "w") as f:
    json.dump(nb, f, indent=2, ensure_ascii=False)
print(f"Saved: {out} ({len(cells)} cells)")
