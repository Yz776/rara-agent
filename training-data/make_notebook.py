#!/usr/bin/env python3
"""Generate rara_finetune.ipynb — just import + run in Colab."""
import json

cells = []

def md(source):
    cells.append({"cell_type": "markdown", "metadata": {}, "source": source})

def code(source):
    cells.append({
        "cell_type": "code",
        "metadata": {},
        "source": source,
        "outputs": [],
        "execution_count": None,
    })

md("# Rara AI Fine-Tuning\n\n**Tinggal import ke Colab + Run All!**\n\nRuntime: T4 GPU | ~10 menit | 153 examples (persona + thinking + tools + agentic + slang)")

code("!pip install -q unsloth datasets")

code("""from unsloth import FastLanguageModel
from datasets import load_dataset

model, tokenizer = FastLanguageModel.from_pretrained(
    "Qwen/Qwen2.5-7B-Instruct",
    load_in_4bit=True,
    max_seq_length=4096,
)
model = FastLanguageModel.get_peft_model(model,
    r=32,
    target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
    lora_alpha=64,
    lora_dropout=0.05,
    use_gradient_checkpointing="unsloth",
)
print(f"Trainable: {sum(p.numel() for p in model.parameters() if p.requires_grad):,}")""")

code("""!wget -q https://raw.githubusercontent.com/Yz776/rara-agent/main/training-data/rara_training_v2.jsonl -O /content/rara_training_v2.jsonl

ds = load_dataset("json", data_files="/content/rara_training_v2.jsonl", split="train")
SYS = 'Kamu Rara. Pakai Aku bukan Saya. Jawab singkat + ceria + emoji. Bahasa Indonesia santai.'
def fmt(x):
    msgs = x["messages"]
    if msgs and msgs[0]["role"] == "system":
        msgs[0]["content"] = SYS
    return {"text": tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)}
ds = ds.map(fmt)
print(f"{len(ds)} examples loaded")""")

code("""from unsloth import UnslothTrainer, UnslothTrainingArguments
trainer = UnslothTrainer(
    model=model, tokenizer=tokenizer, train_dataset=ds,
    dataset_text_field="text", max_seq_length=4096,
    args=UnslothTrainingArguments(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        max_steps=120,
        learning_rate=1.5e-4,
        warmup_steps=10,
        logging_steps=5,
        save_steps=30,
        output_dir="rara",
        report_to="none",
        weight_decay=0.01,
        max_grad_norm=1.0,
        seed=42,
    ),
)
stats = trainer.train()
print(f"Done! Steps={stats.global_step} Loss={stats.training_loss:.4f}")""")

code("""FastLanguageModel.for_inference(model)
for q in ["Halo siapa kamu?","apa kabar?","jam berapa?","cuaca Bandung?","15*12?","cara kerja blockchain?","lagi sedih","gw bosen"]:
    msg=[{"role":"system","content":SYS},{"role":"user","content":q}]
    inp=tokenizer.apply_chat_template(msg,tokenize=True,add_generation_prompt=True,return_tensors="pt").to("cuda")
    out=model.generate(input_ids=inp,max_new_tokens=200,temperature=0.7,do_sample=True,pad_token_id=tokenizer.eos_token_id)
    r=tokenizer.decode(out[0][inp.shape[1]:],skip_special_tokens=True)
    print(f"Q: {q}\\nA: {r}\\n")""")

code("""model.save_pretrained_merged("rara-model", tokenizer, save_method="merged_16bit")
!git clone --depth 1 https://github.com/ggerganov/llama.cpp 2>/dev/null || true
!cd llama.cpp && make -j4 2>/dev/null | tail -1
!python llama.cpp/convert_hf_to_gguf.py rara-model --outtype f16 --outfile rara.gguf
!./llama.cpp/llama-quantize rara.gguf rara-q4.gguf Q4_K_M
print("GGUF ready")""")

code('''HF_TOKEN = "PASTE_TOKEN_DISINI"
from huggingface_hub import create_repo, upload_file
create_repo("Yz776/rara-ai", token=HF_TOKEN, exist_ok=True)
upload_file("rara-q4.gguf", "rara-q4.gguf", "Yz776/rara-ai", token=HF_TOKEN)
print("Uploaded! Deploy:")
print("docker exec kali ollama pull hf.co/Yz776/rara-ai:rara-q4.gguf")
print("echo MODEL=hf.co/Yz776/rara-ai:rara-q4.gguf >> /opt/rara-agent/.env")
print("docker exec kali pm2 restart rara-web")''')

notebook = {
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
    json.dump(notebook, f, indent=2, ensure_ascii=False)

print(f"Saved: {out}")
print(f"Cells: {len(cells)}")
print(f"Size: {len(open(out).read())} bytes")
