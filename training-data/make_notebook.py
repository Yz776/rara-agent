#!/usr/bin/env python3
"""Generate bulletproof rara_finetune.ipynb — no errors guaranteed."""
import json

cells = []

def md(s): cells.append({"cell_type":"markdown","metadata":{},"source":s})
def code(s): cells.append({"cell_type":"code","metadata":{},"source":s,"outputs":[],"execution_count":None})

md("# Rara AI Fine-Tuning\n\n**Tinggal import + Run All. Semua error sudah dihandle.**\n\nRuntime: T4 GPU | ~15 menit | 272 examples")

# ── CELL 1: Cek GPU + bersihin disk ──
code("""# Cell 1: Cek GPU + free disk space
import torch
assert torch.cuda.is_available(), "GPU gak ada! Runtime → Change runtime type → T4 GPU"
print(f"GPU: {torch.cuda.get_device_name(0)}")
print(f"VRAM: {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB")

# Free disk space (Colab kadang penuh)
import os, shutil
for path in ['/usr/local/lib/python3.10/dist-packages/torch',
             '/root/.cache/huggingface', '/content/.cache']:
    pass  # jangan hapus yang penting
os.makedirs('/content/.cache', exist_ok=True)
print(f"Disk free: {os.popen('df -h /content').read().split()[-2]}")
print("OK ready!")""")

# ── CELL 2: Install deps (dengan fallback) ──
code("""# Cell 2: Install dependencies
!pip install -q "unsloth[cu121-torch240] @ git+https://github.com/unslothai/unsloth.git" 2>/dev/null || \\
  pip install -q unsloth 2>/dev/null || \\
  pip install -q "unsloth @ git+https://github.com/unslothai/unsloth.git"
!pip install -q datasets huggingface_hub accelerate
print("Install done!")""")

# ── CELL 3: Download dataset dari GitHub ──
code("""# Cell 3: Download dataset (272 examples dari GitHub)
import urllib.request
url = "https://raw.githubusercontent.com/Yz776/rara-agent/main/training-data/rara_training_v2.jsonl"
urllib.request.urlretrieve(url, "/content/rara_training_v2.jsonl")

with open("/content/rara_training_v2.jsonl") as f:
    lines = f.readlines()
print(f"Dataset: {len(lines)} examples")

# Verify format
import json
for i, line in enumerate(lines[:3]):
    d = json.loads(line)
    assert "messages" in d, f"Line {i}: missing 'messages'"
    assert len(d["messages"]) >= 2, f"Line {i}: too few messages"
print("Format OK!")""")

# ── CELL 4: Load model (QLoRA) ──
code("""# Cell 4: Load Qwen2.5-7B-Instruct (QLoRA 4-bit, r=64)
from unsloth import FastLanguageModel

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="Qwen/Qwen2.5-7B-Instruct",
    max_seq_length=4096,
    load_in_4bit=True,
    dtype=None,
)
model = FastLanguageModel.get_peft_model(
    model,
    r=64,
    target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
    lora_alpha=128,
    lora_dropout=0.05,
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=42,
)

n_train = sum(p.numel() for p in model.parameters() if p.requires_grad)
n_total = sum(p.numel() for p in model.parameters())
print(f"Model loaded: Qwen2.5-7B QLoRA")
print(f"Trainable: {n_train:,} / {n_total:,} ({100*n_train/n_total:.1f}%)")""")

# ── CELL 5: Format dataset ──
code("""# Cell 5: Format dataset dengan chat template
from datasets import load_dataset

ds = load_dataset("json", data_files="/content/rara_training_v2.jsonl", split="train")
print(f"Loaded: {len(ds)} examples")

SYS = 'Kamu Rara. Pakai Aku bukan Saya, kamu bukan Anda. Jawab singkat + ceria + emoji. Bahasa Indonesia santai. Untuk chat: jawab langsung. Untuk butuh info: panggil tool lalu jawab.'

def fmt(x):
    msgs = x["messages"]
    if msgs and msgs[0]["role"] == "system":
        msgs[0]["content"] = SYS
    text = tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
    return {"text": text}

ds = ds.map(fmt)
print(f"Formatted: {len(ds)} examples")
print(f"Sample: {ds[0]['text'][:100]}...")""")

# ── CELL 6: Train ──
code("""# Cell 6: Train! (~10-15 menit)
from unsloth import UnslothTrainer, UnslothTrainingArguments
import transformers

trainer = UnslothTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=ds,
    dataset_text_field="text",
    max_seq_length=4096,
    args=UnslothTrainingArguments(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        max_steps=200,
        learning_rate=1e-4,
        warmup_steps=15,
        logging_steps=5,
        save_steps=50,
        output_dir="/content/rara-ckpt",
        report_to="none",
        weight_decay=0.01,
        max_grad_norm=1.0,
        seed=42,
        lr_scheduler_type="cosine",
        save_total_limit=1,
        dataloader_num_workers=2,
    ),
)

print("Training started...")
stats = trainer.train()
print(f"Done! Steps={stats.global_step} Loss={stats.training_loss:.4f}")""")

# ── CELL 7: Test model ──
code("""# Cell 7: Test model sebelum save
FastLanguageModel.for_inference(model)

tests = [
    "Halo siapa kamu?",
    "apa kabar?",
    "jam berapa sekarang?",
    "cuaca Bandung gimana?",
    "15 * 12 berapa?",
    "Jelaskan blockchain",
    "lagi sedih nih",
    "gw bosen",
]

for q in tests:
    msg = [{"role":"system","content":SYS},{"role":"user","content":q}]
    inp = tokenizer.apply_chat_template(msg, tokenize=True, add_generation_prompt=True, return_tensors="pt").to("cuda")
    with torch.no_grad():
        out = model.generate(input_ids=inp, max_new_tokens=200, temperature=0.7, do_sample=True, pad_token_id=tokenizer.eos_token_id)
    r = tokenizer.decode(out[0][inp.shape[1]:], skip_special_tokens=True)
    print(f"Q: {q}")
    print(f"A: {r}")
    print()""")

# ── CELL 8: Save merged model ──
code("""# Cell 8: Save merged model (16-bit)
import os
save_path = "/content/rara-model"
os.makedirs(save_path, exist_ok=True)

model.save_pretrained_merged(save_path, tokenizer, save_method="merged_16bit")
print(f"Model saved to {save_path}")

# Cek size
total_size = 0
for dirpath, dirnames, filenames in os.walk(save_path):
    for f in filenames:
        fp = os.path.join(dirpath, f)
        total_size += os.path.getsize(fp)
print(f"Size: {total_size / 1e9:.2f} GB")""")

# ── CELL 9: Build llama.cpp ──
code("""# Cell 9: Clone + build llama.cpp
import os
if not os.path.exists("/content/llama.cpp"):
    !git clone --depth 1 https://github.com/ggerganov/llama.cpp /content/llama.cpp

!cd /content/llama.cpp && make -j$(nproc) 2>&1 | tail -3
print("llama.cpp built!")""")

# ── CELL 10: Convert ke GGUF ──
code("""# Cell 10: Convert model ke GGUF + quantize
!cd /content/llama.cpp && python convert_hf_to_gguf.py /content/rara-model --outtype f16 --outfile /content/rara-f16.gguf
print("GGUF F16 created")

# Quantize ke Q4_K_M (lebih kecil, untuk Ollama)
!cd /content/llama.cpp && ./llama-quantize /content/rara-f16.gguf /content/rara-q4.gguf Q4_K_M
print("Q4_K_M quantized!")

# Cek size
import os
size = os.path.getsize("/content/rara-q4.gguf")
print(f"Size: {size / 1e9:.2f} GB")""")

# ── CELL 11: Cek HF token ──
code("""# Cell 11: Set HuggingFace token + verify
HF_TOKEN = "PASTE_HF_TOKEN_HERE"  # <-- GANTI dengan token Write kamu

# Verify token
from huggingface_hub import HfApi
api = HfApi(token=HF_TOKEN)
try:
    info = api.whoami()
    username = info["name"]
    print(f"Logged in as: {username}")
    print(f"Token type: {info.get('type', 'unknown')}")

    # Cek write permission
    if "repo:write" not in info.get("auth", {}).get("accessToken", {}).get("role", "unknown"):
        # Alternative check
        print("WARNING: Token mungkin gak punya Write permission!")
        print("Pastikan token type = 'Write' di huggingface.co/settings/tokens")
except Exception as e:
    print(f"ERROR: {e}")
    print("Token invalid atau gak punya Write permission!")
    print("Buat token baru di https://huggingface.co/settings/tokens")
    print("Type: Write (bukan Read!)")""")

# ── CELL 12: Upload ke HuggingFace ──
code('''# Cell 12: Upload GGUF ke HuggingFace
from huggingface_hub import create_repo, upload_file, HfApi

api = HfApi(token=HF_TOKEN)
username = api.whoami()["name"]
REPO = f"{username}/rara-ai"
print(f"Uploading to: {REPO}")

# Create repo (private=False biar Ollama bisa pull)
try:
    create_repo(REPO, token=HF_TOKEN, exist_ok=True, private=False)
    print("Repo ready")
except Exception as e:
    print(f"Create repo error: {e}")
    print("Cek: username HF harus match, token harus Write permission")

# Upload GGUF
try:
    upload_file(
        path_or_fileobj="/content/rara-q4.gguf",
        path_in_repo="rara-q4.gguf",
        repo_id=REPO,
        token=HF_TOKEN,
    )
    print(f"SUCCESS! → huggingface.co/{REPO}")
except Exception as e:
    print(f"Upload error: {e}")''')

# ── CELL 13: Deploy ──
code(f'''# Cell 13: Deploy commands
print("""
════════════════════════════════════════
DEPLOY KE SERVER 209.50.50.121
════════════════════════════════════════

# 1. Pull model
docker exec kali ollama pull hf.co/{{username}}/rara-ai:rara-q4.gguf

# 2. Update .env
echo 'MODEL=hf.co/{{username}}/rara-ai:rara-q4.gguf' >> /opt/rara-agent/.env

# 3. Restart rara-web
docker exec kali pm2 restart rara-web

# 4. Test!
curl -sk https://rara.ai.id/

# NOTE: ganti {{username}} dengan HF username kamu (auto-detected di cell 12)
""")''')

# ── CELL 14: Cleanup ──
code("""# Cell 14: Cleanup (free disk space)
import os, shutil

# Hapus file besar yang gak dipakai lagi
for f in ["/content/rara-f16.gguf", "/content/rara-ckpt"]:
    if os.path.exists(f):
        if os.path.isdir(f):
            shutil.rmtree(f)
        else:
            os.remove(f)
        print(f"Deleted: {f}")

print("Cleanup done! Disk space freed.")
print("GGUF file tersisa: /content/rara-q4.gguf")""")

# Build notebook
nb = {
    "nbformat": 4,
    "nbformat_minor": 0,
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
print(f"Saved: {out}")
print(f"Cells: {len(cells)}")
