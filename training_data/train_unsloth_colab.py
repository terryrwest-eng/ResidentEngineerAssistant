"""
Zero-Cost QLoRA Fine-Tuning Script for Terry's Resident Engineer / Inspector Voice.

Runs for $0.00 on a free Google Colab T4 / Kaggle GPU, or locally on an 8 GB+ NVIDIA GPU.

Setup in Google Colab (run once in a cell):
    !pip install -q "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
    !pip install -q --no-deps trl peft accelerate bitsandbytes

Upload `inspector_voice_train.jsonl` and `inspector_voice_val.jsonl` to `/content/`
(or run from `DAILY-REPORTER-V3/training_data/`), then run:
    python train_unsloth_colab.py

Outputs:
1. `terry-inspector-lora/` — PEFT LoRA weights (for Fireworks / Together serverless hosting)
2. `terry-inspector-gguf/` — Q4_K_M GGUF (~4.7 GB for 7B, fits 100% in RTX 5060 8 GB VRAM via Ollama)
"""

from __future__ import annotations

import logging
import os
import pathlib

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("train_inspector_voice")

# Default 7B fits 100% inside an 8 GB GPU (e.g., RTX 5060 Laptop GPU) as Q4_K_M GGUF.
# For cloud serverless LoRA hosting (Fireworks / Together), set:
#   BASE_MODEL = "unsloth/Qwen2.5-14B-Instruct-bnb-4bit"  or  "unsloth/Qwen2.5-32B-Instruct-bnb-4bit"
BASE_MODEL: str = os.environ.get(
    "INSPECTOR_BASE_MODEL", "unsloth/Qwen2.5-7B-Instruct-bnb-4bit"
)
MAX_SEQ_LENGTH: int = 8192
LORA_RANK: int = 16
LORA_ALPHA: int = 16
NUM_EPOCHS: int = 3
LEARNING_RATE: float = 2e-4
PER_DEVICE_BATCH_SIZE: int = 2
GRADIENT_ACCUMULATION_STEPS: int = 4

DATA_DIR = pathlib.Path(__file__).resolve().parent
TRAIN_FILE = DATA_DIR / "inspector_voice_train.jsonl"
VAL_FILE = DATA_DIR / "inspector_voice_val.jsonl"
LORA_OUT_DIR = DATA_DIR / "terry-inspector-lora"
GGUF_OUT_DIR = DATA_DIR / "terry-inspector-gguf"


def main() -> None:
    if not TRAIN_FILE.exists() or not VAL_FILE.exists():
        raise FileNotFoundError(
            f"Missing training files in {DATA_DIR}. "
            "Run `python backend/scripts/build_inspector_dataset.py` first."
        )

    from datasets import load_dataset
    from trl import SFTConfig, SFTTrainer
    from unsloth import FastLanguageModel, is_bfloat16_supported
    from unsloth.chat_templates import get_chat_template

    logger.info("Loading base model: %s (max_seq_length=%d)", BASE_MODEL, MAX_SEQ_LENGTH)
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL,
        max_seq_length=MAX_SEQ_LENGTH,
        dtype=None,
        load_in_4bit=True,
    )

    tokenizer = get_chat_template(tokenizer, chat_template="qwen-2.5")

    model = FastLanguageModel.get_peft_model(
        model,
        r=LORA_RANK,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_alpha=LORA_ALPHA,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=3407,
    )

    raw_datasets = load_dataset(
        "json",
        data_files={
            "train": str(TRAIN_FILE),
            "validation": str(VAL_FILE),
        },
    )

    def format_prompts(batch: dict) -> dict:
        texts = [
            tokenizer.apply_chat_template(
                convo, tokenize=False, add_generation_prompt=False
            )
            for convo in batch["messages"]
        ]
        return {"text": texts}

    formatted = raw_datasets.map(format_prompts, batched=True)
    logger.info(
        "Formatted %d train examples and %d validation examples",
        len(formatted["train"]),
        len(formatted["validation"]),
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=formatted["train"],
        eval_dataset=formatted["validation"],
        args=SFTConfig(
            dataset_text_field="text",
            max_seq_length=MAX_SEQ_LENGTH,
            per_device_train_batch_size=PER_DEVICE_BATCH_SIZE,
            gradient_accumulation_steps=GRADIENT_ACCUMULATION_STEPS,
            warmup_ratio=0.05,
            num_train_epochs=NUM_EPOCHS,
            learning_rate=LEARNING_RATE,
            fp16=not is_bfloat16_supported(),
            bf16=is_bfloat16_supported(),
            logging_steps=10,
            eval_strategy="epoch",
            optim="adamw_8bit",
            weight_decay=0.01,
            lr_scheduler_type="cosine",
            seed=3407,
            output_dir=str(DATA_DIR / "checkpoints"),
            report_to="none",
        ),
    )

    logger.info("Starting QLoRA fine-tuning...")
    stats = trainer.train()
    logger.info("Training complete: %s", stats.metrics)

    logger.info("Saving PEFT LoRA adapter to %s", LORA_OUT_DIR)
    model.save_pretrained(str(LORA_OUT_DIR))
    tokenizer.save_pretrained(str(LORA_OUT_DIR))

    logger.info("Exporting Q4_K_M GGUF for local Ollama to %s", GGUF_OUT_DIR)
    model.save_pretrained_gguf(
        str(GGUF_OUT_DIR),
        tokenizer,
        quantization_method="q4_k_m",
    )
    logger.info("Export complete.")


if __name__ == "__main__":
    main()
