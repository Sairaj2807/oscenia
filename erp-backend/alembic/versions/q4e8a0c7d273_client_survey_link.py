"""client survey link

``projects.survey_link_version`` revokes every copy of a project's survey link when it is bumped (the
link is a signed token that carries the version, like the guest and client-edit links).
``client_feedback.source`` says whether a rating came from the client's own link or was entered by
staff, and ``submitted_at`` when; both are for the record, neither changes how the pool is worked out.

Revision ID: q4e8a0c7d273
Revises: p3d7f9b4c162
Create Date: 2026-10-14 09:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'q4e8a0c7d273'
down_revision: str | None = 'p3d7f9b4c162'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('survey_link_version', sa.Integer(), server_default='1', nullable=False))
    op.create_check_constraint(op.f('ck_projects_survey_link_version_positive'), 'projects', 'survey_link_version >= 1')
    op.add_column('client_feedback', sa.Column('source', sa.String(length=8), server_default='staff', nullable=False))
    op.add_column('client_feedback', sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(op.f('ck_client_feedback_source_known'), 'client_feedback', "source IN ('staff', 'client')")


def downgrade() -> None:
    op.drop_constraint(op.f('ck_client_feedback_source_known'), 'client_feedback', type_='check')
    op.drop_column('client_feedback', 'submitted_at')
    op.drop_column('client_feedback', 'source')
    op.drop_constraint(op.f('ck_projects_survey_link_version_positive'), 'projects', type_='check')
    op.drop_column('projects', 'survey_link_version')
