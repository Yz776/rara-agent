# ============================================================================
# Rara AI Fine-Tuning Notebook for Google Colab
# ============================================================================
# 
# Cara pakai:
# 1. Buka https://colab.research.google.com
# 2. Upload file ini (atau copy-paste ke setiap cell)
# 3. Set Runtime → T4 GPU (gratis) atau A100 (Colab Pro)
# 4. Upload rara_training.jsonl (dari folder training-data/)
# 5. Run setiap cell secara berurutan
#
# Output: GGUF file yang bisa di-pull ke Ollama
# ============================================================================

# ═══════════════════════════════════════════════════════════════════════════
# CELL 1: Install dependencies
# ═══════════════════════════════════════════════════════════════════════════
!pip install -q unsloth
!pip install -q "datasets>=2.16.0"
!pip install -q git+https://github.com/unslothai/unsloth.git

# Also install packages for GGUF conversion
!pip install -q llama-cpp-python
!git clone https://github.com/ggerganov/llama.cpp.git /content/llama.cpp
!cd /content/llama.cpp && make -j4

print("✓ Dependencies installed")

# ═══════════════════════════════════════════════════════════════════════════
# CELL 2: Load model + tokenizer (QLoRA for memory efficiency)
# ═══════════════════════════════════════════════════════════════════════════
from unsloth import FastLanguageModel
import torch

MODEL_NAME = "Qwen/Qwen2.5-7B-Instruct"  # or "Qwen/Qwen2.5-3B-Instruct" for faster training
MAX_SEQ_LEN = 2048
DTYPE = None  # auto-detect (float16 for T4, bfloat16 for A100)
LOAD_4BIT = True  # QLoRA: load in 4-bit for memory efficiency

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=MODEL_NAME,
    max_seq_length=MAX_SEQ_LEN,
    dtype=DTYPE,
    load_in_4bit=LOAD_4BIT,
)

# Add LoRA adapters (only train a small subset of parameters)
model = FastLanguageModel.get_peft_model(
    model,
    r=16,  # LoRA rank — higher = better quality, more memory
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
    lora_alpha=32,
    lora_dropout=0.05,
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=42,
)

print(f"✓ Model loaded: {MODEL_NAME}")
print(f"  Trainable parameters: {sum(p.numel() for p in model.parameters() if p.requires_grad):,}")
print(f"  Total parameters: {sum(p.numel() for p in model.parameters()):,}")

# ═══════════════════════════════════════════════════════════════════════════
# CELL 3: Load + format training dataset
# ═══════════════════════════════════════════════════════════════════════════
from datasets import load_dataset
import json

# Upload rara_training.jsonl first (via the file browser on the left)
# Then load it:
dataset = load_dataset("json", data_files="/content/rara_training.jsonl", split="train")

print(f"✓ Dataset loaded: {len(dataset)} examples")
print(f"  Sample: {dataset[0]}")

# Format using Qwen chat template
SYSTEM_PROMPT = """Kamu Rara — asisten AI ceria. Aturan MUTLAK:
1. PAKAI "Aku" — DILARANG "Saya". PAKAI "kamu" — DILARANG "Anda".
2. Jawab SINGKAT (2-5 kalimat). Langsung ke jawaban. TANPA pembukaan.
3. Bahasa Indonesia santai + ceria. Boleh 1-2 emoji (✨😊🌸).
4. Jangan bilang "Terima kasih telah bertanya" — LANGSUNG JAWAB."""

def format_prompt(example):
    messages = example["messages"]
    # Ensure system prompt is set
    if not messages or messages[0]["role"] != "system":
        messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages
    else:
        messages[0]["content"] = SYSTEM_PROMPT
    
    # Use Qwen chat template
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    return {"text": text}

dataset = dataset.map(format_prompt)
print(f"✓ Dataset formatted with chat template")
print(f"  Sample text (first 200 chars): {dataset[0]['text'][:200]}")

# ═══════════════════════════════════════════════════════════════════════════
# CELL 4: Train! (SFT — Supervised Fine-Tuning)
# ═══════════════════════════════════════════════════════════════════════════
from transformers import TrainingArguments
from unsloth import UnslothTrainer, UnslothTrainingArguments

trainer = UnslothTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    dataset_text_field="text",
    max_seq_length=MAX_SEQ_LEN,
    args=UnslothTrainingArguments(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        max_steps=60,  # 172 examples × 4 epochs ≈ 60 steps
        learning_rate=2e-4,
        warmup_steps=5,
        logging_steps=5,
        save_strategy="steps",
        save_steps=20,
        output_dir="/content/rara-checkpoints",
        report_to="none",
        seed=42,
    ),
)

# START TRAINING!
print("🚀 Starting training...")
trainer_stats = trainer.train()
print(f"✓ Training complete!")
print(f"  Total steps: {trainer_stats.global_step}")
print(f"  Training loss: {trainer_stats.training_loss:.4f}")

# ═══════════════════════════════════════════════════════════════════════════
# CELL 5: Test the fine-tuned model
# ═══════════════════════════════════════════════════════════════════════════
FastLanguageModel.for_inference(model)

test_questions = [
    "Halo siapa kamu?",
    "apa kabar?",
    "jam berapa sekarang?",
    "lagi apa nih?",
    "kamu bisa apa aja?",
]

for q in test_questions:
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": q},
    ]
    inputs = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, return_tensors="pt").to("cuda")
    outputs = model.generate(input_ids=inputs, max_new_tokens=150, temperature=0.7, do_sample=True)
    response = tokenizer.decode(outputs[0][inputs.shape[1]:], skip_special_tokens=True)
    print(f"Q: {q}")
    print(f"A: {response}")
    print()

# ═══════════════════════════════════════════════════════════════════════════
# CELL 6: Save model + convert to GGUF for Ollama
# ═══════════════════════════════════════════════════════════════════════════

# Save LoRA adapter
model.save_pretrained("/content/rara-lora")
tokenizer.save_pretrained("/content/rara-lora")
print("✓ LoRA adapter saved")

# Merge LoRA + save full model
model.save_pretrained_merged("/content/rara-merged", tokenizer, save_method="merged_16bit")
print("✓ Full model merged + saved (16-bit)")

# Convert to GGUF for Ollama
# First, save as HuggingFace format (needed for llama.cpp conversion)
model.save_pretrained_merged("/content/rara-hf", tokenizer, save_method="merged_16bit")

# Convert to GGUF using llama.cpp
!cd /content/llama.cpp && python convert_hf_to_gguf.py /content/rara-hf --outtype f16 --outfile /content/rara.gguf

# Quantize to Q4_K_M (same as our other models)
!cd /content/llama.cpp && ./llama-quantize /content/rara.gguf /content/rara-q4_k_m.gguf Q4_K_M

print("✓ GGUF model created: /content/rara-q4_k_m.gguf")

# ═══════════════════════════════════════════════════════════════════════════
# CELL 7: Upload to HuggingFace (so server can pull it)
# ═══════════════════════════════════════════════════════════════════════════
# You need a HuggingFace account + token (https://huggingface.co/settings/tokens)

from huggingface_hub import HuggingFaceAPI, create_repo

HF_TOKEN = "YOUR_HF_TOKEN_HERE"  # ← ganti dengan token HuggingFace kamu
REPO_NAME = "Yz776/rara-ai"  # ← nama repo di HuggingFace

# Create repo if not exists
create_repo(REPO_NAME, token=HF_TOKEN, exist_ok=True)

# Upload GGUF
api = HuggingFaceAPI(token=HF_TOKEN)
api.upload_file(
    path_or_fileobj="/content/rara-q4_k_m.gguf",
    path_in_repo="rara-q4_k_m.gguf",
    repo_id=REPO_NAME,
    token=HF_TOKEN,
)

print(f"✓ Uploaded to https://huggingface.co/{REPO_NAME}")
print(f"  File: rara-q4_k_m.gguf")

# ═══════════════════════════════════════════════════════════════════════════
# CELL 8: Commands to deploy on server
# ═══════════════════════════════════════════════════════════════════════════
print("""
══════════════════════════════════════════════════════════════
DEPLOY COMMANDS (run on server 209.50.50.121):
══════════════════════════════════════════════════════════════

# 1. Pull the fine-tuned model
docker exec kali ollama pull hf.co/Yz776/rara-ai:rara-q4_k_m.gguf

# 2. Update .env to use the fine-tuned model
echo "MODEL=hf.co/Yz776/rara-ai:rara-q4_k_m.gguf" >> /opt/rara-agent/.env

# 3. Restart rara-web
docker exec kali pm2 restart rara-web

# 4. Test!
curl -sk -X POST -H 'Content-Type: application/json' \\
  -H 'User-Agent: Mozilla/5.0' -d '{}' \\
  https://rara.ai.id/api/auth | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])"

# Then test chat with the fine-tuned model!
""")
