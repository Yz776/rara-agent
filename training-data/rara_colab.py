# ═══════════════════════════════════════════════════════════════
# Rara AI — Comprehensive Fine-Tuning (Thinking + Tools + Persona)
# ═══════════════════════════════════════════════════════════════
#
# CARA PAKAI:
# 1. Buka colab.research.google.com → Runtime: T4 GPU (gratis)
# 2. Upload rara_training_v2.jsonl (klik folder icon di kiri → upload)
# 3. Run semua cell ↓ (total ~10 menit)
# ═══════════════════════════════════════════════════════════════

# ── CELL 1: Install ──
!pip install -q unsloth datasets

# ── CELL 2: Load model (QLoRA 4-bit, higher rank for more capacity) ──
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained(
    "Qwen/Qwen2.5-7B-Instruct",  # base model with native tool calling
    load_in_4bit=True,
    max_seq_length=4096,  # longer context for tool calls + reasoning
)
# Higher LoRA rank (r=32) for better learning of thinking + tools + persona
model = FastLanguageModel.get_peft_model(model,
    r=32,  # was 16 — higher = better quality
    target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
    lora_alpha=64,  # was 32 — match 2x rank
    lora_dropout=0.05,
    use_gradient_checkpointing="unsloth",
)
print(f"Trainable params: {sum(p.numel() for p in model.parameters() if p.requires_grad):,}")

# ── CELL 3: Load data (153 examples: persona + thinking + tools + agentic) ──
from datasets import load_dataset
ds = load_dataset("json", data_files="/content/rara_training_v2.jsonl", split="train")
ds = ds.map(lambda x: {"text": tokenizer.apply_chat_template(x["messages"], tokenize=False, add_generation_prompt=False)})
print(f"{len(ds)} examples loaded")

# ── CELL 4: Train! (more steps for better learning) ──
from unsloth import UnslothTrainer, UnslothTrainingArguments
trainer = UnslothTrainer(
    model=model, tokenizer=tokenizer, train_dataset=ds,
    dataset_text_field="text", max_seq_length=4096,
    args=UnslothTrainingArguments(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        max_steps=120,  # was 60 — more steps for thinking + tools
        learning_rate=1.5e-4,  # slightly lower for stable training
        warmup_steps=10,
        logging_steps=5,
        save_steps=30,
        output_dir="rara",
        report_to="none",
        weight_decay=0.01,  # regularization
        max_grad_norm=1.0,  # gradient clipping
        seed=42,
    ),
)
trainer.train()
print("✓ Training done!")

# ── CELL 5: Test (persona + tools + thinking) ──
FastLanguageModel.for_inference(model)
tests = [
    "Halo siapa kamu?",
    "apa kabar?",
    "jam berapa sekarang?",
    "cuaca di Bandung gimana?",
    "15 * 12 berapa?",
    "Jelaskan cara kerja blockchain",
    "kamu bisa apa aja?",
    "lagi sedih nih",
]
SYS = 'Kamu Rara — asisten AI ceria. Pakai "Aku" bukan "Saya". Jawab singkat + ceria + emoji. Bahasa Indonesia santai. Untuk chat: jawab langsung. Untuk butuh info: panggil tool lalu jawab.'
for q in tests:
    msg = [{"role":"system","content":SYS},{"role":"user","content":q}]
    inp = tokenizer.apply_chat_template(msg, tokenize=True, add_generation_prompt=True, return_tensors="pt").to("cuda")
    out = model.generate(input_ids=inp, max_new_tokens=200, temperature=0.7, do_sample=True, pad_token_id=tokenizer.eos_token_id)
    r = tokenizer.decode(out[0][inp.shape[1]:], skip_special_tokens=True)
    print(f"Q: {q}\nA: {r}\n")

# ── CELL 6: Save GGUF + upload ──
HF_TOKEN = "PASTE_HF_TOKEN"  # ← ganti dengan token huggingface.co/settings/tokens
model.save_pretrained_merged("rara-model", tokenizer, save_method="merged_16bit")
!git clone --depth 1 https://github.com/ggerganov/llama.cpp && cd llama.cpp && make -j4
!python llama.cpp/convert_hf_to_gguf.py rara-model --outtype f16 --outfile rara.gguf
!./llama.cpp/llama-quantize rara.gguf rara-q4.gguf Q4_K_M
from huggingface_hub import create_repo, upload_file
create_repo("Yz776/rara-ai", token=HF_TOKEN, exist_ok=True)
upload_file("rara-q4.gguf", "rara-q4.gguf", "Yz776/rara-ai", token=HF_TOKEN)
print("✓ Upload done! → huggingface.co/Yz776/rara-ai")

# ── CELL 7: Deploy ──
print("""
Server 209.50.50.121:

docker exec kali ollama pull hf.co/Yz776/rara-ai:rara-q4.gguf
echo 'MODEL=hf.co/Yz776/rara-ai:rara-q4.gguf' >> /opt/rara-agent/.env
docker exec kali pm2 restart rara-web
""")
