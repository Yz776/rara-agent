# ═══════════════════════════════════════════════════════════════
# Rara Fine-Tuning — Google Colab (Simple Version)
# ═══════════════════════════════════════════════════════════════
#
# CARA PAKAI:
# 1. Buka colab.research.google.com → Runtime: T4 GPU
# 2. Upload rara_training.jsonl (klik folder icon di kiri → upload)
# 3. Run semua cell ↓
# ═══════════════════════════════════════════════════════════════

# ── CELL 1: Install ──
!pip install -q unsloth datasets

# ── CELL 2: Load model ──
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained("Qwen/Qwen2.5-7B-Instruct", load_in_4bit=True, max_seq_length=2048)
model = FastLanguageModel.get_peft_model(model, r=16, target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"])

# ── CELL 3: Load data ──
from datasets import load_dataset
ds = load_dataset("json", data_files="/content/rara_training.jsonl", split="train")
ds = ds.map(lambda x: {"text": tokenizer.apply_chat_template(x["messages"], tokenize=False, add_generation_prompt=False)})
print(f"{len(ds)} examples loaded")

# ── CELL 4: Train (5 menit) ──
from unsloth import UnslothTrainer, UnslothTrainingArguments
trainer = UnslothTrainer(model=model, tokenizer=tokenizer, train_dataset=ds, dataset_text_field="text", max_seq_length=2048,
    args=UnslothTrainingArguments(per_device_train_batch_size=2, gradient_accumulation_steps=4, max_steps=60,
        learning_rate=2e-4, warmup_steps=5, logging_steps=5, save_steps=20, output_dir="rara", report_to="none"))
trainer.train()
print("✓ Training done!")

# ── CELL 5: Test ──
FastLanguageModel.for_inference(model)
for q in ["Halo siapa kamu?", "apa kabar?", "jam berapa?"]:
    msg = [{"role":"system","content":'Kamu Rara. Pakai "Aku" bukan "Saya". Singkat + ceria + emoji.'},{"role":"user","content":q}]
    inp = tokenizer.apply_chat_template(msg, tokenize=True, add_generation_prompt=True, return_tensors="pt").to("cuda")
    out = model.generate(input_ids=inp, max_new_tokens=100, temperature=0.7, do_sample=True)
    print(f"Q: {q}\nA: {tokenizer.decode(out[0][inp.shape[1]:], skip_special_tokens=True)}\n")

# ── CELL 6: Save + upload ke HuggingFace ──
# Set HF token: daftar di huggingface.co/settings/tokens
HF_TOKEN = "PASTE_TOKEN_HERE"  # ← ganti
model.save_pretrained_merged("rara-model", tokenizer, save_method="merged_16bit")
!git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp && make -j4
!python llama.cpp/convert_hf_to_gguf.py rara-model --outtype f16 --outfile rara.gguf
!./llama.cpp/llama-quantize rara.gguf rara-q4.gguf Q4_K_M
from huggingface_hub import create_repo, upload_file
create_repo("Yz776/rara-ai", token=HF_TOKEN, exist_ok=True)
upload_file("rara-q4.gguf", "rara-q4.gguf", "Yz776/rara-ai", token=HF_TOKEN)
print("✓ Upload done! → huggingface.co/Yz776/rara-ai")

# ── CELL 7: Deploy ke server ──
print("""
Run di server 209.50.50.121:

docker exec kali ollama pull hf.co/Yz776/rara-ai:rara-q4.gguf
echo 'MODEL=hf.co/Yz776/rara-ai:rara-q4.gguf' >> /opt/rara-agent/.env
docker exec kali pm2 restart rara-web
""")
